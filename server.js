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

// In-memory single-session image cache
let currentImageBuffer = null;
let currentImageMime = '';

// Route to handle raw binary uploads
app.post('/api/upload', express.raw({ type: 'image/*', limit: '100mb' }), (req, res) => {
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ error: 'No image data uploaded' });
  }
  currentImageBuffer = req.body;
  currentImageMime = req.headers['content-type'] || 'image/jpeg';
  res.json({ success: true, size: currentImageBuffer.length });
});

// Helper function to process the image via Sharp
async function processImage(buffer, params) {
  const { cropX, cropY, cropW, cropH, width, height, format, quality } = params;
  
  let pipeline = sharp(buffer);
  
  // 1. Crop
  pipeline = pipeline.extract({
    left: Math.round(parseFloat(cropX)),
    top: Math.round(parseFloat(cropY)),
    width: Math.round(parseFloat(cropW)),
    height: Math.round(parseFloat(cropH))
  });
  
  // 2. Resize
  pipeline = pipeline.resize(
    Math.round(parseInt(width)),
    Math.round(parseInt(height)),
    { fit: 'fill' }
  );
  
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
    case 'image/heic':
    case 'image/heif':
      try {
        return { buffer: await pipeline.heif({ quality: q, compression: 'av1' }).toBuffer(), mime: 'image/heic' };
      } catch (err) {
        // Fallback for standard HEIF / HEIC compilation differences
        return { buffer: await pipeline.heif({ quality: q }).toBuffer(), mime: 'image/heic' };
      }
    case 'image/jxl':
      return { buffer: await pipeline.jxl({ quality: q }).toBuffer(), mime: 'image/jxl' };
    case 'image/svg+xml': {
      const pngRes = await pipeline.png().toBuffer();
      const base64 = pngRes.toString('base64');
      const svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <image width="${width}" height="${height}" href="data:image/png;base64,${base64}"/>
</svg>`;
      return { buffer: Buffer.from(svgString), mime: 'image/svg+xml' };
    }
    case 'image/jpeg':
    default:
      return { buffer: await pipeline.jpeg({ quality: q }).toBuffer(), mime: 'image/jpeg' };
  }
}

// Route to estimate output size
app.post('/api/estimate', async (req, res) => {
  if (!currentImageBuffer) {
    return res.status(400).json({ error: 'No image uploaded yet' });
  }
  
  try {
    const result = await processImage(currentImageBuffer, req.body);
    res.json({ success: true, size: result.buffer.length });
  } catch (err) {
    res.status(500).json({ error: `Formatting error: ${err.message}` });
  }
});

// Route to download processed image
app.post('/api/download', async (req, res) => {
  if (!currentImageBuffer) {
    return res.status(400).json({ error: 'No image uploaded yet' });
  }
  
  try {
    const result = await processImage(currentImageBuffer, req.body);
    res.setHeader('Content-Type', result.mime);
    res.send(result.buffer);
  } catch (err) {
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
