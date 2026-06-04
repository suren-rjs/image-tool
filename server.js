import express from 'express';
import open from 'open';
import path from 'path';
import { fileURLToPath } from 'url';

import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Body parsing middlewares
app.use(express.json());

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// Multi-session in-memory image cache
const imageCache = new Map();

function addToCache(buffer, mime) {
  const id = Math.random().toString(36).substring(2, 15);
  imageCache.set(id, { buffer, mime, timestamp: Date.now() });

  // Prevent memory leaks: prune cache if it exceeds 100 items
  if (imageCache.size > 100) {
    const sorted = [...imageCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    // Delete the oldest 50 items
    for (let i = 0; i < 50; i++) {
      imageCache.delete(sorted[i][0]);
    }
  }
  return id;
}

function getImageFromCache(id) {
  if (id && imageCache.has(id)) {
    return imageCache.get(id);
  }
  return { buffer: currentImageBuffer, mime: currentImageMime };
}

// In-memory single-session image cache (legacy fallback)
let currentImageBuffer = null;
let currentImageMime = '';

// Route to handle raw binary uploads
app.post('/api/upload', express.raw({ type: 'image/*', limit: '100mb' }), (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'No image data uploaded' });
  }
  currentImageBuffer = req.body;
  currentImageMime = req.headers['content-type'] || 'image/jpeg';
  
  const id = addToCache(currentImageBuffer, currentImageMime);
  res.json({ success: true, id, size: currentImageBuffer.length });
});

// Helper function to compress image to a specific target file size (for websites, e.g. 200kb)
async function compressToTargetSize(buffer, params) {
  const { cropX, cropY, cropW, cropH, width, height, format, targetSize } = params;
  const targetBytes = parseInt(targetSize) || 204800; // Default to 200KB (204800 bytes)
  const mimeType = format || 'image/jpeg';

  let basePipeline = sharp(buffer);

  // 1. Crop (with safe boundary clamping)
  if (cropX !== undefined && cropY !== undefined && cropW !== undefined && cropH !== undefined) {
    const meta = await basePipeline.metadata();
    let left = Math.max(0, Math.round(parseFloat(cropX)));
    let top = Math.max(0, Math.round(parseFloat(cropY)));
    let cropWidth = Math.round(parseFloat(cropW));
    let cropHeight = Math.round(parseFloat(cropH));

    if (left + cropWidth > meta.width) {
      cropWidth = meta.width - left;
    }
    if (top + cropHeight > meta.height) {
      cropHeight = meta.height - top;
    }

    if (cropWidth > 0 && cropHeight > 0) {
      basePipeline = basePipeline.extract({
        left: left,
        top: top,
        width: cropWidth,
        height: cropHeight
      });
    }
  }

  // 2. Resolve target dimensions
  let targetW = width ? Math.round(parseInt(width)) : null;
  let targetH = height ? Math.round(parseInt(height)) : null;

  if (!targetW || !targetH) {
    const meta = await basePipeline.metadata();
    targetW = targetW || meta.width;
    targetH = targetH || meta.height;
  }

  basePipeline = basePipeline.resize(targetW, targetH, { fit: 'fill' });

  // Generate intermediate buffer for fast iterative checks
  const baseBuffer = await basePipeline.toBuffer();
  const formatName = mimeType.split('/')[1].replace('+xml', '');
  const supportsQuality = ['image/jpeg', 'image/webp', 'image/avif', 'image/tiff'].includes(mimeType);

  // Helper function to encode sharp pipeline
  const encodeQuality = async (buf, q) => {
    const p = sharp(buf);
    switch (mimeType) {
      case 'image/webp':
        return p.webp({ quality: q }).toBuffer();
      case 'image/avif':
        return p.avif({ quality: q }).toBuffer();
      case 'image/tiff':
        return p.tiff({ quality: q }).toBuffer();
      case 'image/jpeg':
      default:
        return p.jpeg({ quality: q }).toBuffer();
    }
  };

  if (!supportsQuality) {
    // Lossless formats (PNG, GIF) or SVG. Check if standard conversion fits.
    let resultBuffer = await sharp(baseBuffer).toFormat(formatName).toBuffer();
    if (resultBuffer.length <= targetBytes) {
      return { buffer: resultBuffer, mime: mimeType };
    }

    // Downscale dimension iteratively if it exceeds the limit
    let scale = 0.9;
    let iterations = 0;
    while (resultBuffer.length > targetBytes && scale > 0.1 && iterations < 8) {
      const w = Math.max(1, Math.round(targetW * scale));
      const h = Math.max(1, Math.round(targetH * scale));
      resultBuffer = await sharp(baseBuffer)
        .resize(w, h, { fit: 'fill' })
        .toFormat(formatName)
        .toBuffer();
      scale -= 0.1;
      iterations++;
    }
    return { buffer: resultBuffer, mime: mimeType };
  }

  // Binary search quality parameter to get as close to target size as possible
  let minQ = 10;
  let maxQ = 95;
  let bestQ = 80;
  let bestBuffer = null;
  let iterations = 0;

  while (minQ <= maxQ && iterations < 7) {
    const midQ = Math.floor((minQ + maxQ) / 2);
    try {
      const tempBuffer = await encodeQuality(baseBuffer, midQ);
      if (tempBuffer.length <= targetBytes) {
        bestQ = midQ;
        bestBuffer = tempBuffer;
        minQ = midQ + 1; // Try to maximize quality
      } else {
        maxQ = midQ - 1; // Too big, decrease quality
        if (!bestBuffer || tempBuffer.length < bestBuffer.length) {
          bestBuffer = tempBuffer;
        }
      }
    } catch (e) {
      break;
    }
    iterations++;
  }

  if (!bestBuffer) {
    bestBuffer = await encodeQuality(baseBuffer, 80);
  }

  // If even quality 10 exceeds target size, we must downscale dimensions
  if (bestBuffer.length > targetBytes) {
    let scale = 0.9;
    let scaleIterations = 0;
    while (bestBuffer.length > targetBytes && scale > 0.1 && scaleIterations < 8) {
      const w = Math.max(1, Math.round(targetW * scale));
      const h = Math.max(1, Math.round(targetH * scale));
      const scaledBase = await sharp(baseBuffer).resize(w, h, { fit: 'fill' }).toBuffer();

      let sMinQ = 10;
      let sMaxQ = 75;
      let sBuffer = null;
      let sIterations = 0;

      while (sMinQ <= sMaxQ && sIterations < 5) {
        const midQ = Math.floor((sMinQ + sMaxQ) / 2);
        try {
          const tempB = await encodeQuality(scaledBase, midQ);
          if (tempB.length <= targetBytes) {
            sBuffer = tempB;
            sMinQ = midQ + 1;
          } else {
            sMaxQ = midQ - 1;
            if (!sBuffer || tempB.length < sBuffer.length) {
              sBuffer = tempB;
            }
          }
        } catch (e) {
          break;
        }
        sIterations++;
      }

      if (sBuffer) {
        bestBuffer = sBuffer;
      }
      scale -= 0.1;
      scaleIterations++;
    }
  }

  return { buffer: bestBuffer, mime: mimeType };
}

// Helper function to process the image via Sharp
async function processImage(buffer, params) {
  const { cropX, cropY, cropW, cropH, width, height, format, quality, compressMode, targetSize } = params;
  
  if (compressMode === 'target') {
    return compressToTargetSize(buffer, params);
  }

  let pipeline = sharp(buffer);
  
  // 1. Crop (with safe boundary clamping)
  if (cropX !== undefined && cropY !== undefined && cropW !== undefined && cropH !== undefined) {
    const meta = await pipeline.metadata();
    let left = Math.max(0, Math.round(parseFloat(cropX)));
    let top = Math.max(0, Math.round(parseFloat(cropY)));
    let cropWidth = Math.round(parseFloat(cropW));
    let cropHeight = Math.round(parseFloat(cropH));

    if (left + cropWidth > meta.width) {
      cropWidth = meta.width - left;
    }
    if (top + cropHeight > meta.height) {
      cropHeight = meta.height - top;
    }

    if (cropWidth > 0 && cropHeight > 0) {
      pipeline = pipeline.extract({
        left: left,
        top: top,
        width: cropWidth,
        height: cropHeight
      });
    }
  }
  
  // 2. Resize
  if (width && height) {
    pipeline = pipeline.resize(
      Math.round(parseInt(width)),
      Math.round(parseInt(height)),
      { fit: 'fill' }
    );
  }
  
  // 3. Format & Quality conversion
  const q = Math.round(parseFloat(quality) * 100) || 80;
  
  switch (format) {
    case 'image/png':
      return { buffer: await pipeline.png().toBuffer(), mime: 'image/png' };
    case 'image/gif':
      return { buffer: await pipeline.gif().toBuffer(), mime: 'image/gif' };
    case 'image/webp':
      return { buffer: await pipeline.webp({ quality: q }).toBuffer(), mime: 'image/webp' };
    case 'image/avif':
      return { buffer: await pipeline.avif({ quality: q }).toBuffer(), mime: 'image/avif' };
    case 'image/tiff':
      return { buffer: await pipeline.tiff({ quality: q }).toBuffer(), mime: 'image/tiff' };
    case 'image/jpeg':
    default:
      return { buffer: await pipeline.jpeg({ quality: q }).toBuffer(), mime: 'image/jpeg' };
  }
}

// Route to estimate output size
app.post('/api/estimate', async (req, res) => {
  const { id } = req.body;
  const imageInfo = getImageFromCache(id);

  if (!imageInfo || !imageInfo.buffer) {
    return res.status(400).json({ error: 'No image uploaded yet' });
  }
  
  try {
    const result = await processImage(imageInfo.buffer, req.body);
    res.json({ success: true, size: result.buffer.length });
  } catch (err) {
    console.error('Size estimation error:', err);
    res.status(500).json({ error: `Formatting error: ${err.message}` });
  }
});

// Route to download processed image
app.post('/api/download', async (req, res) => {
  const { id } = req.body;
  const imageInfo = getImageFromCache(id);

  if (!imageInfo || !imageInfo.buffer) {
    return res.status(400).json({ error: 'No image uploaded yet' });
  }
  
  try {
    const result = await processImage(imageInfo.buffer, req.body);
    res.setHeader('Content-Type', result.mime);
    res.send(result.buffer);
  } catch (err) {
    console.error('Download processing error:', err);
    res.status(500).json({ error: `Failed to download: ${err.message}` });
  }
});

// Fallback to index.html for single-page apps
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  
  console.clear();
  console.log('\x1b[36m%s\x1b[0m', '==================================================');
  console.log('\x1b[35m%s\x1b[0m', '         ✦ ANTIGRAVITY IMAGE EDITOR STUDIO ✦       ');
  console.log('\x1b[36m%s\x1b[0m', '==================================================');
  console.log(`\x1b[32m✔ Server is running successfully.\x1b[0m`);
  console.log(`\x1b[34mℹ Local URL:  \x1b[4m${url}\x1b[0m`);
  console.log('\x1b[36m%s\x1b[0m', '==================================================');
  console.log('\x1b[90m%s\x1b[0m', 'Opening web browser to localhost...');

  try {
    // Open in browser
    await open(url);
    console.log('\x1b[32m✔ Browser opened successfully!\x1b[0m');
  } catch (error) {
    console.error('\x1b[31m✘ Failed to open browser automatically:\x1b[0m', error.message);
    console.log(`\x1b[33m⚡ Please manually open your browser and navigate to: ${url}\x1b[0m`);
  }
});
