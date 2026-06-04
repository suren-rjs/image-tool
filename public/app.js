// State Management
let originalFile = null;
let originalFileId = null; // Backend session cache ID
let img = new Image();

const canvas = document.getElementById('editor-canvas');
const ctx = canvas.getContext('2d');
const cropOverlay = document.getElementById('crop-overlay');

// Dimensions on screen
let canvasWidth = 0;
let canvasHeight = 0;
let imgScaleFactor = 1; // naturalWidth / canvasWidth

// Crop box in screen coordinates
let cropBox = { x: 0, y: 0, w: 0, h: 0 };

// Selected aspect ratio
let activeRatio = 'free'; // 'free', '1:1', '4:3', '16:9'
let ratioValue = null;

// Compression options
let activeFormat = 'image/jpeg';
let activeQuality = 0.8;
let compressMode = 'target'; // 'target' or 'manual'
let targetSizeKB = 200;

// Bulk processing state
let bulkQueue = [];
let currentEditingQueueIndex = -1;

// Dragging / Resizing State
let dragStart = { x: 0, y: 0 };
let boxStart = { x: 0, y: 0, w: 0, h: 0 };
let isDraggingBox = false;
let activeHandle = null;

// Debounce timer for size estimations
let estimateDebounceTimer = null;

/* DOM ELEMENTS */
const uploadStage = document.getElementById('upload-stage');
const editorStage = document.getElementById('editor-stage');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const btnChangeImage = document.getElementById('btn-change-image');
const btnResetCrop = document.getElementById('btn-reset-crop');

const infoOriginalDim = document.getElementById('info-original-dim');
const infoOriginalSize = document.getElementById('info-original-size');
const infoCurrentDim = document.getElementById('info-current-dim');
const infoEstimatedSize = document.getElementById('info-estimated-size');

const ratioBtns = document.querySelectorAll('.ratio-btn');
const lockRatioCheckbox = document.getElementById('lock-ratio');
const inputWidth = document.getElementById('input-width');
const inputHeight = document.getElementById('input-height');
const presetPills = document.querySelectorAll('.preset-pill');

const formatBtns = document.querySelectorAll('.format-btn');
const qualitySection = document.getElementById('quality-section');
const inputQuality = document.getElementById('input-quality');
const qualityValueLabel = document.getElementById('quality-value');

const btnDownload = document.getElementById('btn-download');
const savingsPercent = document.getElementById('savings-percent');
const savingsCircle = document.getElementById('savings-circle');
const savingsGaugeText = document.getElementById('savings-gauge-text');
const canvasWrapper = document.getElementById('canvas-wrapper');
const savingsCard = document.getElementById('savings-card');

/* =========================================================================
   1. UPLOAD AND INITIALIZATION
   ========================================================================= */

// Setup Click to Browse bindings
dropZone.addEventListener('click', () => {
  // If the user clicks the dropzone itself, trigger file browse by default
  fileInput.click();
});

document.getElementById('btn-browse-files').addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

document.getElementById('btn-browse-folder').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('folder-input').click();
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    if (e.target.files.length === 1) {
      handleFile(e.target.files[0]);
    } else {
      handleMultipleFiles(Array.from(e.target.files));
    }
  }
});

document.getElementById('folder-input').addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    handleMultipleFiles(Array.from(e.target.files));
  }
});

// Drag and drop events
['dragenter', 'dragover'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  }, false);
});

['dragleave', 'drop'].forEach(eventName => {
  dropZone.addEventListener(eventName, (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
  }, false);
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  
  const dt = e.dataTransfer;
  if (dt.items && dt.items.length > 0) {
    const files = await getFilesFromDataTransfer(dt);
    if (files.length === 1) {
      handleFile(files[0]);
    } else if (files.length > 1) {
      handleMultipleFiles(files);
    }
  } else if (dt.files && dt.files.length > 0) {
    const files = Array.from(dt.files);
    if (files.length === 1) {
      handleFile(files[0]);
    } else if (files.length > 1) {
      handleMultipleFiles(files);
    }
  }
});

btnChangeImage.addEventListener('click', () => {
  if (currentEditingQueueIndex !== -1) {
    // Save editor settings back to queue item
    const item = bulkQueue[currentEditingQueueIndex];
    const exportW = parseInt(inputWidth.value) || 1;
    const exportH = parseInt(inputHeight.value) || 1;

    const naturalCropX = Math.round(cropBox.x * imgScaleFactor);
    const naturalCropY = Math.round(cropBox.y * imgScaleFactor);
    const naturalCropW = Math.round(cropBox.w * imgScaleFactor);
    const naturalCropH = Math.round(cropBox.h * imgScaleFactor);

    item.params = {
      compressMode: compressMode,
      targetSize: targetSizeKB * 1024,
      format: activeFormat,
      quality: activeQuality,
      cropX: naturalCropX,
      cropY: naturalCropY,
      cropW: naturalCropW,
      cropH: naturalCropH,
      width: exportW,
      height: exportH
    };

    item.status = 'queued';
    currentEditingQueueIndex = -1;
    btnChangeImage.textContent = 'Upload New';

    editorStage.classList.add('workspace-hidden');
    document.getElementById('bulk-stage').classList.remove('workspace-hidden');

    renderQueueTable();
    uploadAndPreprocessQueue();
  } else {
    uploadStage.classList.remove('workspace-hidden');
    editorStage.classList.add('workspace-hidden');
    fileInput.value = '';
    originalFile = null;
    originalFileId = null;
  }
});

function handleFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Please upload an image file (PNG, JPEG, WEBP, GIF, etc.)');
    return;
  }

  // Upload to server raw body parser
  fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Content-Type': file.type
    },
    body: file
  })
  .then(res => {
    if (!res.ok) throw new Error('Failed to upload image to server cache.');
    return res.json();
  })
  .then(data => {
    originalFile = file;
    originalFileId = data.id;
    infoOriginalSize.textContent = formatBytes(file.size);

    const reader = new FileReader();
    reader.onload = (e) => {
      img = new Image();
      img.onload = () => {
        uploadStage.classList.add('workspace-hidden');
        editorStage.classList.remove('workspace-hidden');
        infoOriginalDim.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
        
        // Match buttons in sidebar
        const standardTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/tiff'];
        if (standardTypes.includes(file.type)) {
          setExportFormat(file.type);
        } else {
          setExportFormat('image/jpeg');
        }

        // Default to target size compression mode
        document.getElementById('single-mode-target').checked = true;
        compressMode = 'target';
        targetSizeKB = 200;
        document.getElementById('input-target-size').value = 200;
        updateSingleModeUI();

        initWorkspace();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  })
  .catch(err => {
    alert('Server upload error: ' + err.message);
  });
}

function initWorkspace() {
  if (!img.naturalWidth) return;

  // Calculate viewport boundaries
  const maxW = canvasWrapper.clientWidth - 48; // padding
  const maxH = canvasWrapper.clientHeight - 48;
  
  let targetW = img.naturalWidth;
  let targetH = img.naturalHeight;

  // Fit image to viewport
  const ratio = targetW / targetH;
  if (targetW > maxW) {
    targetW = maxW;
    targetH = targetW / ratio;
  }
  if (targetH > maxH) {
    targetH = maxH;
    targetW = targetH * ratio;
  }

  canvasWidth = Math.round(targetW);
  canvasHeight = Math.round(targetH);
  imgScaleFactor = img.naturalWidth / canvasWidth;

  // Set canvas dimension properties
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  // Draw image on canvas
  ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

  // Position parent container exactly around canvas
  const container = document.getElementById('editor-container');
  container.style.width = `${canvasWidth}px`;
  container.style.height = `${canvasHeight}px`;

  // Clear ratio constraints to start with Free form
  setRatio('free');
  resetCropBox();
  
  // Update inputs and UI
  updateCropOverlayUI();
  updateExportDimensionInputs();
  triggerSavingsRecalculation();
}

function resetCropBox() {
  if (ratioValue) {
    // Fit aspect ratio inside screen canvas centered
    const ratio = ratioValue;
    let targetW = canvasWidth;
    let targetH = canvasHeight;

    if (canvasWidth / canvasHeight > ratio) {
      targetW = canvasHeight * ratio;
    } else {
      targetH = canvasWidth / ratio;
    }

    cropBox.w = Math.round(targetW);
    cropBox.h = Math.round(targetH);
  } else {
    // Free mode: full size
    cropBox.w = canvasWidth;
    cropBox.h = canvasHeight;
  }

  cropBox.x = Math.round((canvasWidth - cropBox.w) / 2);
  cropBox.y = Math.round((canvasHeight - cropBox.h) / 2);
}

btnResetCrop.addEventListener('click', () => {
  resetCropBox();
  updateCropOverlayUI();
  updateExportDimensionInputs();
  triggerSavingsRecalculation();
});

// Window resize handler to maintain editor fitting
window.addEventListener('resize', () => {
  if (!originalFile || !img.naturalWidth) return;

  const oldW = canvasWidth;
  const oldH = canvasHeight;

  // Re-run fitting calculation
  const maxW = canvasWrapper.clientWidth - 48;
  const maxH = canvasWrapper.clientHeight - 48;
  
  let targetW = img.naturalWidth;
  let targetH = img.naturalHeight;
  const ratio = targetW / targetH;

  if (targetW > maxW) {
    targetW = maxW;
    targetH = targetW / ratio;
  }
  if (targetH > maxH) {
    targetH = maxH;
    targetW = targetH * ratio;
  }

  canvasWidth = Math.round(targetW);
  canvasHeight = Math.round(targetH);
  imgScaleFactor = img.naturalWidth / canvasWidth;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

  const container = document.getElementById('editor-container');
  container.style.width = `${canvasWidth}px`;
  container.style.height = `${canvasHeight}px`;

  // Scale the crop box proportionally
  cropBox.x = (cropBox.x / oldW) * canvasWidth;
  cropBox.y = (cropBox.y / oldH) * canvasHeight;
  cropBox.w = (cropBox.w / oldW) * canvasWidth;
  cropBox.h = (cropBox.h / oldH) * canvasHeight;

  updateCropOverlayUI();
});

/* =========================================================================
   2. ASPECT RATIO HANDLERS
   ========================================================================= */

ratioBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    ratioBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setRatio(btn.dataset.ratio);
  });
});

function setRatio(ratioString) {
  activeRatio = ratioString;
  
  if (ratioString === 'free') {
    ratioValue = null;
    cropOverlay.classList.remove('ratio-locked');
  } else {
    cropOverlay.classList.add('ratio-locked');
    const parts = ratioString.split(':');
    ratioValue = parseInt(parts[0]) / parseInt(parts[1]);
  }

  resetCropBox();
  updateCropOverlayUI();
  updateExportDimensionInputs();
  triggerSavingsRecalculation();
}

/* =========================================================================
   3. DRAGGABLE CROP OVERLAY ENGINE
   ========================================================================= */

cropOverlay.addEventListener('mousedown', startDrag);
cropOverlay.addEventListener('touchstart', startDrag, { passive: false });

function startDrag(e) {
  e.preventDefault();
  
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  dragStart.x = clientX;
  dragStart.y = clientY;

  boxStart.x = cropBox.x;
  boxStart.y = cropBox.y;
  boxStart.w = cropBox.w;
  boxStart.h = cropBox.h;

  if (e.target.classList.contains('crop-handle')) {
    activeHandle = e.target.dataset.handle;
    isDraggingBox = false;
  } else {
    isDraggingBox = true;
    activeHandle = null;
  }

  if (e.touches) {
    document.addEventListener('touchmove', dragMove, { passive: false });
    document.addEventListener('touchend', endDrag);
  } else {
    document.addEventListener('mousemove', dragMove);
    document.addEventListener('mouseup', endDrag);
  }
}

function dragMove(e) {
  if (!isDraggingBox && !activeHandle) return;
  e.preventDefault();

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  const dx = clientX - dragStart.x;
  const dy = clientY - dragStart.y;

  if (isDraggingBox) {
    let newX = boxStart.x + dx;
    let newY = boxStart.y + dy;

    // Bounds checking
    if (newX < 0) newX = 0;
    if (newY < 0) newY = 0;
    if (newX + boxStart.w > canvasWidth) newX = canvasWidth - boxStart.w;
    if (newY + boxStart.h > canvasHeight) newY = canvasHeight - boxStart.h;

    cropBox.x = Math.round(newX);
    cropBox.y = Math.round(newY);
  } else if (activeHandle) {
    let newX = boxStart.x;
    let newY = boxStart.y;
    let newW = boxStart.w;
    let newH = boxStart.h;

    const minSize = 40; // minimum overlay size in screen pixels

    if (!ratioValue) {
      // --- FREE RESIZING ---
      switch (activeHandle) {
        case 'r':
          newW = Math.max(minSize, Math.min(canvasWidth - boxStart.x, boxStart.w + dx));
          break;
        case 'b':
          newH = Math.max(minSize, Math.min(canvasHeight - boxStart.y, boxStart.h + dy));
          break;
        case 'l': {
          const maxLeftDx = boxStart.x + boxStart.w - minSize;
          const clampedDx = Math.max(-boxStart.x, Math.min(maxLeftDx, dx));
          newX = boxStart.x + clampedDx;
          newW = boxStart.w - clampedDx;
          break;
        }
        case 't': {
          const maxTopDy = boxStart.y + boxStart.h - minSize;
          const clampedDy = Math.max(-boxStart.y, Math.min(maxTopDy, dy));
          newY = boxStart.y + clampedDy;
          newH = boxStart.h - clampedDy;
          break;
        }
        case 'br':
          newW = Math.max(minSize, Math.min(canvasWidth - boxStart.x, boxStart.w + dx));
          newH = Math.max(minSize, Math.min(canvasHeight - boxStart.y, boxStart.h + dy));
          break;
        case 'tr':
          newW = Math.max(minSize, Math.min(canvasWidth - boxStart.x, boxStart.w + dx));
          const maxTopDyTr = boxStart.y + boxStart.h - minSize;
          const clampedDyTr = Math.max(-boxStart.y, Math.min(maxTopDyTr, dy));
          newY = boxStart.y + clampedDyTr;
          newH = boxStart.h - clampedDyTr;
          break;
        case 'bl': {
          const maxLeftDxBl = boxStart.x + boxStart.w - minSize;
          const clampedDxBl = Math.max(-boxStart.x, Math.min(maxLeftDxBl, dx));
          newX = boxStart.x + clampedDxBl;
          newW = boxStart.w - clampedDxBl;
          newH = Math.max(minSize, Math.min(canvasHeight - boxStart.y, boxStart.h + dy));
          break;
        }
        case 'tl': {
          const maxLeftDxTl = boxStart.x + boxStart.w - minSize;
          const clampedDxTl = Math.max(-boxStart.x, Math.min(maxLeftDxTl, dx));
          newX = boxStart.x + clampedDxTl;
          newW = boxStart.w - clampedDxTl;

          const maxTopDyTl = boxStart.y + boxStart.h - minSize;
          const clampedDyTl = Math.max(-boxStart.y, Math.min(maxTopDyTl, dy));
          newY = boxStart.y + clampedDyTl;
          newH = boxStart.h - clampedDyTl;
          break;
        }
      }
    } else {
      // --- ASPECT RATIO LOCKED RESIZING ---
      let targetW = boxStart.w;
      let targetH = boxStart.h;

      switch (activeHandle) {
        case 'br': {
          targetW = Math.max(minSize, Math.min(canvasWidth - boxStart.x, boxStart.w + dx));
          targetH = targetW / ratioValue;

          if (boxStart.y + targetH > canvasHeight) {
            targetH = canvasHeight - boxStart.y;
            targetW = targetH * ratioValue;
          }
          break;
        }
        case 'bl': {
          const maxLeftDx = boxStart.x + boxStart.w - minSize;
          const clampedDx = Math.max(-boxStart.x, Math.min(maxLeftDx, dx));
          targetW = boxStart.w - clampedDx;
          targetH = targetW / ratioValue;

          if (boxStart.y + targetH > canvasHeight) {
            targetH = canvasHeight - boxStart.y;
            targetW = targetH * ratioValue;
          }
          newX = boxStart.x + (boxStart.w - targetW);
          break;
        }
        case 'tr': {
          targetW = Math.max(minSize, Math.min(canvasWidth - boxStart.x, boxStart.w + dx));
          targetH = targetW / ratioValue;

          const calculatedY = boxStart.y + (boxStart.h - targetH);
          if (calculatedY < 0) {
            targetH = boxStart.y + boxStart.h;
            targetW = targetH * ratioValue;
          }
          newY = boxStart.y + (boxStart.h - targetH);
          break;
        }
        case 'tl': {
          const maxLeftDx = boxStart.x + boxStart.w - minSize;
          const clampedDx = Math.max(-boxStart.x, Math.min(maxLeftDx, dx));
          targetW = boxStart.w - clampedDx;
          targetH = targetW / ratioValue;

          const calculatedY = boxStart.y + (boxStart.h - targetH);
          if (calculatedY < 0) {
            targetH = boxStart.y + boxStart.h;
            targetW = targetH * ratioValue;
          }

          newX = boxStart.x + (boxStart.w - targetW);
          newY = boxStart.y + (boxStart.h - targetH);
          break;
        }
      }

      newW = targetW;
      newH = targetH;
    }

    cropBox.x = Math.round(newX);
    cropBox.y = Math.round(newY);
    cropBox.w = Math.round(newW);
    cropBox.h = Math.round(newH);
  }

  updateCropOverlayUI();
  updateExportDimensionInputs();
}

function endDrag() {
  isDraggingBox = false;
  activeHandle = null;

  if (window.TouchEvent) {
    document.removeEventListener('touchmove', dragMove);
    document.removeEventListener('touchend', endDrag);
  }
  document.removeEventListener('mousemove', dragMove);
  document.removeEventListener('mouseup', endDrag);

  // Recalculate size estimation once drag is completed
  triggerSavingsRecalculation();
}

function updateCropOverlayUI() {
  if (cropBox.w === 0 || cropBox.h === 0) return;

  cropOverlay.style.display = 'block';
  cropOverlay.style.left = `${cropBox.x}px`;
  cropOverlay.style.top = `${cropBox.y}px`;
  cropOverlay.style.width = `${cropBox.w}px`;
  cropOverlay.style.height = `${cropBox.h}px`;
}

/* =========================================================================
   4. DIMENSIONS & RESIZING METRICS
   ========================================================================= */

function updateExportDimensionInputs() {
  const currentNaturalW = Math.round(cropBox.w * imgScaleFactor);
  const currentNaturalH = Math.round(cropBox.h * imgScaleFactor);

  inputWidth.value = currentNaturalW;
  inputHeight.value = currentNaturalH;

  infoCurrentDim.textContent = `${currentNaturalW} × ${currentNaturalH} px`;
}

// Check checkbox value
lockRatioCheckbox.addEventListener('change', () => {
  isRatioLocked = lockRatioCheckbox.checked;
});

// Dimension updates manually
inputWidth.addEventListener('input', () => {
  const w = parseInt(inputWidth.value) || 0;
  if (w <= 0) return;

  const currentCropRatio = cropBox.w / cropBox.h;

  if (isRatioLocked) {
    const h = Math.round(w / currentCropRatio);
    inputHeight.value = h;
  }
  infoCurrentDim.textContent = `${w} × ${inputHeight.value} px`;
  triggerSavingsRecalculation();
});

inputHeight.addEventListener('input', () => {
  const h = parseInt(inputHeight.value) || 0;
  if (h <= 0) return;

  const currentCropRatio = cropBox.w / cropBox.h;

  if (isRatioLocked) {
    const w = Math.round(h * currentCropRatio);
    inputWidth.value = w;
  }
  infoCurrentDim.textContent = `${inputWidth.value} × ${h} px`;
  triggerSavingsRecalculation();
});

// Presets implementation
presetPills.forEach(pill => {
  pill.addEventListener('click', () => {
    const percentage = parseInt(pill.dataset.preset);
    const naturalCropW = Math.round(cropBox.w * imgScaleFactor);
    const naturalCropH = Math.round(cropBox.h * imgScaleFactor);

    const targetW = Math.round(naturalCropW * (percentage / 100));
    const targetH = Math.round(naturalCropH * (percentage / 100));

    inputWidth.value = targetW;
    inputHeight.value = targetH;
    infoCurrentDim.textContent = `${targetW} × ${targetH} px`;

    triggerSavingsRecalculation();
  });
});

/* =========================================================================
   5. FORMAT & QUALITY SELECTION
   ========================================================================= */

// Single editor mode switcher bindings
const singleModeTarget = document.getElementById('single-mode-target');
const singleModeManual = document.getElementById('single-mode-manual');
const singleTargetSizeSection = document.getElementById('single-target-size-section');
const inputTargetSize = document.getElementById('input-target-size');

function updateSingleModeUI() {
  if (singleModeTarget.checked) {
    compressMode = 'target';
    singleTargetSizeSection.classList.remove('hidden');
    qualitySection.classList.add('hidden');
  } else {
    compressMode = 'manual';
    singleTargetSizeSection.classList.add('hidden');
    qualitySection.classList.remove('hidden');
  }
}

singleModeTarget.addEventListener('change', () => {
  updateSingleModeUI();
  triggerSavingsRecalculation();
});

singleModeManual.addEventListener('change', () => {
  updateSingleModeUI();
  triggerSavingsRecalculation();
});

inputTargetSize.addEventListener('input', () => {
  targetSizeKB = parseInt(inputTargetSize.value) || 200;
  triggerSavingsRecalculation();
});

formatBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    formatBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setExportFormat(btn.dataset.format);
  });
});

function setExportFormat(format) {
  activeFormat = format;

  // JPEG, WEBP, AVIF, and TIFF support quality parameters
  const supportsQuality = ['image/jpeg', 'image/webp', 'image/avif', 'image/tiff'].includes(format);
  if (supportsQuality) {
    qualitySection.classList.remove('hidden');
  } else {
    qualitySection.classList.add('hidden');
  }

  // Update button active state in DOM if initialized
  formatBtns.forEach(b => {
    if (b.dataset.format === format) b.classList.add('active');
    else b.classList.remove('active');
  });

  triggerSavingsRecalculation();
}

inputQuality.addEventListener('input', () => {
  const val = inputQuality.value;
  qualityValueLabel.textContent = `${val}%`;
  activeQuality = val / 100;
  triggerSavingsRecalculation();
});

/* =========================================================================
   6. REAL-TIME FILE SIZE ESTIMATION ENGINE
   ========================================================================= */

function triggerSavingsRecalculation() {
  if (estimateDebounceTimer) clearTimeout(estimateDebounceTimer);
  estimateDebounceTimer = setTimeout(calculateSavings, 150);
}

function calculateSavings() {
  if (!originalFile || !img.naturalWidth || !originalFileId) return;

  // Show visual loading indicators
  savingsCard.classList.add('processing');
  infoEstimatedSize.textContent = 'Calculating...';

  const exportW = parseInt(inputWidth.value) || 1;
  const exportH = parseInt(inputHeight.value) || 1;

  // Convert crop screen dimensions into original dimensions
  const naturalCropX = Math.round(cropBox.x * imgScaleFactor);
  const naturalCropY = Math.round(cropBox.y * imgScaleFactor);
  const naturalCropW = Math.round(cropBox.w * imgScaleFactor);
  const naturalCropH = Math.round(cropBox.h * imgScaleFactor);

  const payload = {
    id: originalFileId,
    cropX: naturalCropX,
    cropY: naturalCropY,
    cropW: naturalCropW,
    cropH: naturalCropH,
    width: exportW,
    height: exportH,
    format: activeFormat,
    quality: activeQuality,
    compressMode: compressMode,
    targetSize: targetSizeKB * 1024
  };

  fetch('/api/estimate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(res => {
    if (!res.ok) throw new Error('Size estimation failed');
    return res.json();
  })
  .then(data => {
    savingsCard.classList.remove('processing');
    if (!data.success) throw new Error(data.error || 'Size estimation failed');
    const newSize = data.size;
    infoEstimatedSize.textContent = formatBytes(newSize);

    // Math for savings meter
    const savings = Math.max(0, Math.round((1 - newSize / originalFile.size) * 100));
    
    savingsPercent.textContent = savings > 0 ? `${savings}% smaller` : '0% smaller';
    savingsGaugeText.textContent = `${savings}%`;

    // Update circular dasharray
    savingsCircle.setAttribute('stroke-dasharray', `${savings}, 100`);
  })
  .catch(err => {
    savingsCard.classList.remove('processing');
    console.warn('Backend size estimation failed: ', err.message);
    infoEstimatedSize.textContent = 'N/A';
    savingsPercent.textContent = 'Savings N/A';
    savingsGaugeText.textContent = '-';
    savingsCircle.setAttribute('stroke-dasharray', '0, 100');
  });
}

/* =========================================================================
   7. EXPORT AND DOWNLOAD FUNCTIONALITY
   ========================================================================= */

btnDownload.addEventListener('click', () => {
  if (!originalFile || !img.naturalWidth || !originalFileId) return;

  const exportW = parseInt(inputWidth.value) || 1;
  const exportH = parseInt(inputHeight.value) || 1;

  const naturalCropX = Math.round(cropBox.x * imgScaleFactor);
  const naturalCropY = Math.round(cropBox.y * imgScaleFactor);
  const naturalCropW = Math.round(cropBox.w * imgScaleFactor);
  const naturalCropH = Math.round(cropBox.h * imgScaleFactor);

  const payload = {
    id: originalFileId,
    cropX: naturalCropX,
    cropY: naturalCropY,
    cropW: naturalCropW,
    cropH: naturalCropH,
    width: exportW,
    height: exportH,
    format: activeFormat,
    quality: activeQuality,
    compressMode: compressMode,
    targetSize: targetSizeKB * 1024
  };

  // Visual feedback: change button state to processing
  const originalText = btnDownload.innerHTML;
  btnDownload.disabled = true;
  btnDownload.innerHTML = `
    <svg class="animate-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite; margin-right: 8px; display: inline-block;">
      <circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="15"></circle>
    </svg>
    Processing Image...
  `;

  fetch('/api/download', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  .then(res => {
    if (!res.ok) {
      return res.json().then(json => {
        throw new Error(json.error || 'Server processing error');
      });
    }
    return res.blob();
  })
  .then(blob => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    // Mappings for file extensions
    let ext = 'jpg';
    if (activeFormat === 'image/png') ext = 'png';
    else if (activeFormat === 'image/gif') ext = 'gif';
    else if (activeFormat === 'image/webp') ext = 'webp';
    else if (activeFormat === 'image/avif') ext = 'avif';
    else if (activeFormat === 'image/tiff') ext = 'tiff';

    const originalName = originalFile.name.substring(0, originalFile.name.lastIndexOf('.'));
    link.download = `${originalName}_edited.${ext}`;
    
    link.href = url;
    document.body.appendChild(link);
    link.click();
    
    // Clean up
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  })
  .catch(err => {
    alert('Download failed: ' + err.message);
  })
  .finally(() => {
    btnDownload.disabled = false;
    btnDownload.innerHTML = originalText;
  });
});

/* =========================================================================
   8. UTILITIES & BULK COMPRESSION QUEUE ENGINE
   ========================================================================= */

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Read folder files recursively
async function getFilesFromDataTransfer(dataTransfer) {
  const files = [];
  const items = Array.from(dataTransfer.items);
  const queue = [];

  for (const item of items) {
    if (item.kind === 'file') {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        queue.push(entry);
      }
    }
  }

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry.isFile) {
      const file = await getFileFromEntry(entry);
      if (file) {
        files.push(file);
      }
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const entries = await readAllEntries(dirReader);
      queue.push(...entries);
    }
  }
  return files;
}

function getFileFromEntry(entry) {
  return new Promise((resolve) => {
    entry.file(resolve, () => resolve(null));
  });
}

function readAllEntries(dirReader) {
  return new Promise((resolve) => {
    const allEntries = [];
    function readNext() {
      dirReader.readEntries((entries) => {
        if (entries.length === 0) {
          resolve(allEntries);
        } else {
          allEntries.push(...entries);
          readNext();
        }
      }, () => resolve(allEntries));
    }
    readNext();
  });
}

// Bulk Queue State & Event listeners
const bulkModeTarget = document.getElementById('bulk-mode-target');
const bulkModeManual = document.getElementById('bulk-mode-manual');
const bulkTargetSizeSection = document.getElementById('bulk-target-size-section');
const bulkQualitySection = document.getElementById('bulk-quality-section');
const bulkInputQuality = document.getElementById('bulk-input-quality');
const bulkQualityValue = document.getElementById('bulk-quality-value');
const bulkFormatSelectors = document.getElementById('bulk-format-selectors');
const bulkResizeToggle = document.getElementById('bulk-resize-toggle');
const bulkResizeDimensions = document.getElementById('bulk-resize-dimensions');
const btnBulkCompress = document.getElementById('btn-bulk-compress');
const btnBulkDownload = document.getElementById('btn-bulk-download');

function updateBulkModeUI() {
  if (bulkModeTarget.checked) {
    bulkTargetSizeSection.classList.remove('hidden');
    bulkQualitySection.classList.add('hidden');
  } else {
    bulkTargetSizeSection.classList.add('hidden');
    bulkQualitySection.classList.remove('hidden');
  }
}

bulkModeTarget.addEventListener('change', updateBulkModeUI);
bulkModeManual.addEventListener('change', updateBulkModeUI);

bulkInputQuality.addEventListener('input', () => {
  bulkQualityValue.textContent = `${bulkInputQuality.value}%`;
});

bulkResizeToggle.addEventListener('change', () => {
  if (bulkResizeToggle.checked) {
    bulkResizeDimensions.classList.remove('hidden');
  } else {
    bulkResizeDimensions.classList.add('hidden');
  }
});

const bulkFormatBtns = bulkFormatSelectors.querySelectorAll('.format-btn');
bulkFormatBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    bulkFormatBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// Handle multiple file selection
function handleMultipleFiles(files) {
  const imageFiles = files.filter(f => f.type.startsWith('image/'));
  if (imageFiles.length === 0) {
    alert('No image files found.');
    return;
  }
  
  imageFiles.forEach(file => {
    const exists = bulkQueue.some(q => q.file.name === file.name && q.file.size === file.size);
    if (!exists) {
      bulkQueue.push({
        id: null,
        file: file,
        status: 'queued',
        originalSize: file.size,
        compressedSize: null,
        blob: null,
        resolvedFormat: null,
        params: {
          compressMode: 'target',
          targetSize: 204800, // Default 200KB
          format: 'original'
        }
      });
    }
  });

  uploadStage.classList.add('workspace-hidden');
  editorStage.classList.add('workspace-hidden');
  document.getElementById('bulk-stage').classList.remove('workspace-hidden');

  renderQueueTable();
  uploadAndPreprocessQueue();
}

async function uploadAndPreprocessQueue() {
  for (let i = 0; i < bulkQueue.length; i++) {
    const item = bulkQueue[i];
    if (item.id && item.status !== 'queued') continue;

    item.status = 'processing';
    renderQueueTable();

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'Content-Type': item.file.type
        },
        body: item.file
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      item.id = data.id;
      item.status = 'ready';
    } catch (e) {
      item.status = 'error';
    }
    renderQueueTable();
  }
}

function renderQueueTable() {
  const tbody = document.getElementById('queue-tbody');
  tbody.innerHTML = '';
  document.getElementById('bulk-queue-count').textContent = bulkQueue.length;

  bulkQueue.forEach((item, index) => {
    const tr = document.createElement('tr');
    
    let statusClass = 'status-queued';
    let statusText = 'Ready';
    
    if (item.status === 'processing') {
      statusClass = 'status-processing';
      statusText = 'Compressing...';
    } else if (item.status === 'queued') {
      statusClass = 'status-queued';
      statusText = 'Queued';
    } else if (item.status === 'done') {
      statusClass = 'status-done';
      statusText = 'Optimized';
    } else if (item.status === 'error') {
      statusClass = 'status-error';
      statusText = 'Failed';
    }

    const origSizeFormatted = formatBytes(item.file.size);
    const compSizeFormatted = item.compressedSize ? formatBytes(item.compressedSize) : '-';

    let targetOutputText = '';
    if (item.status === 'done' && item.compressedSize) {
      const savings = Math.max(0, Math.round((1 - item.compressedSize / item.file.size) * 100));
      targetOutputText = `${compSizeFormatted} <span style="color: var(--success); font-size: 0.8rem; margin-left: 4px;">(-${savings}%)</span>`;
    } else {
      const mode = item.params.compressMode || (bulkModeTarget.checked ? 'target' : 'manual');
      if (mode === 'target') {
        const targetVal = item.params.targetSize ? Math.round(item.params.targetSize / 1024) : document.getElementById('bulk-input-target-size').value;
        targetOutputText = `Target: ${targetVal} KB`;
      } else {
        const qualVal = item.params.quality ? Math.round(item.params.quality * 100) : bulkInputQuality.value;
        targetOutputText = `Quality: ${qualVal}%`;
      }
    }

    const thumbSrc = URL.createObjectURL(item.file);

    tr.innerHTML = `
      <td>
        <img class="queue-thumbnail" src="${thumbSrc}" alt="Preview" onload="URL.revokeObjectURL(this.src)">
      </td>
      <td>
        <div class="queue-item-name" title="${item.file.name}">${item.file.name}</div>
      </td>
      <td class="queue-item-size">${origSizeFormatted}</td>
      <td>
        <span class="status-badge-inline ${statusClass}">${statusText}</span>
      </td>
      <td class="queue-item-size">${targetOutputText}</td>
      <td>
        <div class="action-buttons">
          <button class="btn btn-secondary btn-sm" onclick="editQueueItem(${index})">Edit</button>
          <button class="btn btn-secondary btn-sm" onclick="downloadQueueItem(${index})" ${item.status !== 'done' ? 'disabled' : ''}>Download</button>
          <button class="btn btn-secondary btn-sm btn-danger-hover" onclick="removeQueueItem(${index})">Remove</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function getImageDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const tempImg = new Image();
    tempImg.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: tempImg.naturalWidth, height: tempImg.naturalHeight });
    };
    tempImg.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: 0, height: 0 });
    };
    tempImg.src = url;
  });
}

async function compressAllBulk() {
  const globalMode = bulkModeTarget.checked ? 'target' : 'manual';
  const globalTargetSize = parseInt(document.getElementById('bulk-input-target-size').value) * 1024;
  const globalQuality = parseInt(bulkInputQuality.value) / 100;
  const globalFormat = bulkFormatSelectors.querySelector('.format-btn.active').dataset.format;
  const globalResizeEnabled = bulkResizeToggle.checked;
  const globalMaxWidth = parseInt(document.getElementById('bulk-input-max-width').value) || 1920;
  const globalMaxHeight = parseInt(document.getElementById('bulk-input-max-height').value) || 1080;

  const originalHtml = btnBulkCompress.innerHTML;
  btnBulkCompress.disabled = true;
  btnBulkCompress.innerHTML = `
    <svg class="animate-spin" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 1s linear infinite; margin-right: 8px; display: inline-block;">
      <circle cx="12" cy="12" r="10" stroke-dasharray="31.4" stroke-dashoffset="15"></circle>
    </svg>
    Compressing...
  `;

  for (let i = 0; i < bulkQueue.length; i++) {
    const item = bulkQueue[i];
    if (!item.id || item.status === 'error') continue;

    item.status = 'processing';
    renderQueueTable();

    try {
      const payload = {
        id: item.id,
        compressMode: item.params.compressMode || globalMode,
        targetSize: item.params.targetSize || globalTargetSize,
        format: (item.params.format && item.params.format !== 'original') ? item.params.format : (globalFormat === 'original' ? item.file.type : globalFormat),
        quality: item.params.quality || globalQuality
      };

      // Custom crop values from manual editing
      if (item.params.cropX !== undefined) {
        payload.cropX = item.params.cropX;
        payload.cropY = item.params.cropY;
        payload.cropW = item.params.cropW;
        payload.cropH = item.params.cropH;
        payload.width = item.params.width;
        payload.height = item.params.height;
      } else if (globalResizeEnabled) {
        const dims = await getImageDimensions(item.file);
        let targetW = dims.width;
        let targetH = dims.height;
        const ratio = targetW / targetH;

        if (targetW > globalMaxWidth) {
          targetW = globalMaxWidth;
          targetH = Math.round(targetW / ratio);
        }
        if (targetH > globalMaxHeight) {
          targetH = globalMaxHeight;
          targetW = Math.round(targetH * ratio);
        }

        payload.width = targetW;
        payload.height = targetH;
      }

      const res = await fetch('/api/download', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) throw new Error('Compression failed');
      const blob = await res.blob();
      item.blob = blob;
      item.compressedSize = blob.size;
      item.status = 'done';
      item.resolvedFormat = payload.format;
    } catch (e) {
      item.status = 'error';
    }
    renderQueueTable();
  }

  btnBulkCompress.disabled = false;
  btnBulkCompress.innerHTML = originalHtml;

  const anyDone = bulkQueue.some(q => q.status === 'done');
  btnBulkDownload.disabled = !anyDone;
}

async function downloadAllAsZip() {
  const originalHtml = btnBulkDownload.innerHTML;
  btnBulkDownload.disabled = true;
  btnBulkDownload.innerHTML = 'Generating ZIP...';

  try {
    const zip = new JSZip();
    
    bulkQueue.forEach(item => {
      if (item.status === 'done' && item.blob) {
        let ext = 'jpg';
        const format = item.resolvedFormat || item.file.type;
        if (format === 'image/png') ext = 'png';
        else if (format === 'image/gif') ext = 'gif';
        else if (format === 'image/webp') ext = 'webp';
        else if (format === 'image/avif') ext = 'avif';
        else if (format === 'image/tiff') ext = 'tiff';

        const originalName = item.file.name.substring(0, item.file.name.lastIndexOf('.'));
        zip.file(`${originalName}_optimized.${ext}`, item.blob);
      }
    });

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `opti_crop_bulk_images.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('ZIP generation failed: ' + e.message);
  } finally {
    btnBulkDownload.disabled = false;
    btnBulkDownload.innerHTML = originalHtml;
  }
}

// Global hook references for onclick handlers
window.editQueueItem = (index) => {
  const item = bulkQueue[index];
  currentEditingQueueIndex = index;

  originalFile = item.file;
  originalFileId = item.id;
  infoOriginalSize.textContent = formatBytes(item.file.size);

  const reader = new FileReader();
  reader.onload = (e) => {
    img = new Image();
    img.onload = () => {
      document.getElementById('bulk-stage').classList.add('workspace-hidden');
      editorStage.classList.remove('workspace-hidden');
      infoOriginalDim.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;

      // Match editor parameters
      if (item.params.compressMode === 'target') {
        singleModeTarget.checked = true;
        compressMode = 'target';
        targetSizeKB = Math.round(item.params.targetSize / 1024) || 200;
        inputTargetSize.value = targetSizeKB;
      } else {
        singleModeManual.checked = true;
        compressMode = 'manual';
        activeQuality = item.params.quality || 0.8;
        inputQuality.value = Math.round(activeQuality * 100);
        qualityValueLabel.textContent = `${inputQuality.value}%`;
      }
      updateSingleModeUI();

      if (item.params.format && item.params.format !== 'original') {
        setExportFormat(item.params.format);
      } else {
        setExportFormat(item.file.type);
      }

      btnChangeImage.textContent = '← Save & Return';
      initWorkspace();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(item.file);
};

window.downloadQueueItem = (index) => {
  const item = bulkQueue[index];
  if (item.status === 'done' && item.blob) {
    let ext = 'jpg';
    const format = item.resolvedFormat || item.file.type;
    if (format === 'image/png') ext = 'png';
    else if (format === 'image/gif') ext = 'gif';
    else if (format === 'image/webp') ext = 'webp';
    else if (format === 'image/avif') ext = 'avif';
    else if (format === 'image/tiff') ext = 'tiff';

    const originalName = item.file.name.substring(0, item.file.name.lastIndexOf('.'));
    const url = URL.createObjectURL(item.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${originalName}_optimized.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } else {
    alert('Please compress the queue item first.');
  }
};

window.removeQueueItem = (index) => {
  bulkQueue.splice(index, 1);
  renderQueueTable();
  if (bulkQueue.length === 0) {
    document.getElementById('bulk-stage').classList.add('workspace-hidden');
    uploadStage.classList.remove('workspace-hidden');
  }
};
