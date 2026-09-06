const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');

const MODELS_DIR = path.join(__dirname, '../data/models');
const LAMA_MODEL_PATH = path.join(MODELS_DIR, 'lama_fp32.onnx');
const LAMA_MODEL_URL = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';

let ort = null;
let session = null;
let downloading = false;

async function initOrt() {
    if (ort) return;
    try {
        ort = require('onnxruntime-node');
    } catch (e) {
        logger.error('onnxruntime-node belum terinstall!');
        throw e;
    }
}

async function downloadModel() {
    if (fs.existsSync(LAMA_MODEL_PATH)) return true;
    if (downloading) {
        return new Promise(resolve => {
            const intv = setInterval(() => {
                if (!downloading) {
                    clearInterval(intv);
                    resolve(fs.existsSync(LAMA_MODEL_PATH));
                }
            }, 1000);
        });
    }

    downloading = true;
    logger.info('Mendownload model LaMa Inpainting (sekitar 200MB)... Ini hanya terjadi sekali.');
    
    if (!fs.existsSync(MODELS_DIR)) {
        fs.mkdirSync(MODELS_DIR, { recursive: true });
    }

    try {
        const response = await fetch(LAMA_MODEL_URL);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(LAMA_MODEL_PATH, buffer);
        logger.info('Berhasil mendownload model LaMa Inpainting.');
        downloading = false;
        return true;
    } catch (err) {
        downloading = false;
        logger.error(`Gagal mendownload LaMa: ${err.message}`);
        return false;
    }
}

async function getSession() {
    if (session) return session;
    await initOrt();
    const ready = await downloadModel();
    if (!ready) throw new Error("Model LaMa tidak tersedia.");

    try {
        logger.info('Memuat model LaMa ke ONNX Runtime...');
        session = await ort.InferenceSession.create(LAMA_MODEL_PATH, { executionProviders: ['cpu'] });
        return session;
    } catch (err) {
        logger.error('Gagal memuat model LaMa: ' + err.message);
        throw err;
    }
}

/**
 * @param {Buffer} imageBuffer - original full image
 * @param {Object} box - { x, y, width, height } area to be masked
 * @param {number} padding - extra padding to expand context for the AI
 */
async function inpaintBox(imageBuffer, box, padding = 40) {
    const sess = await getSession();

    const meta = await sharp(imageBuffer).metadata();
    const imgW = meta.width;
    const imgH = meta.height;

    // Calculate crop box (with context padding)
    let cx = Math.max(0, box.x - padding);
    let cy = Math.max(0, box.y - padding);
    let cw = Math.min(imgW - cx, box.width + padding * 2);
    let ch = Math.min(imgH - cy, box.height + padding * 2);

    // The ONNX model strictly expects exactly 512x512.
    const paddedW = 512;
    const paddedH = 512;

    // 1. Extract context region and stretch/shrink to 512x512
    const contextRegionBuffer = await sharp(imageBuffer)
        .extract({ left: cx, top: cy, width: cw, height: ch })
        .resize(512, 512, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();

    // Create a 1 channel mask buffer (1 where the watermark is, 0 otherwise)
    // Scale mask coordinates to 512x512
    const scaleX = 512 / cw;
    const scaleY = 512 / ch;
    const maskX = Math.max(0, box.x - cx) * scaleX;
    const maskY = Math.max(0, box.y - cy) * scaleY;
    const maskW = box.width * scaleX;
    const maskH = box.height * scaleY;

    const numPixels = 512 * 512;
    const imageFloat32 = new Float32Array(numPixels * 3);
    const maskFloat32 = new Float32Array(numPixels * 1);

    for (let y = 0; y < 512; y++) {
        for (let x = 0; x < 512; x++) {
            const idx = y * 512 + x;
            const pxIdx = idx * 3;
            
            // Normalize 0-1
            imageFloat32[idx] = contextRegionBuffer[pxIdx] / 255.0;           // R
            imageFloat32[numPixels + idx] = contextRegionBuffer[pxIdx + 1] / 255.0; // G
            imageFloat32[numPixels * 2 + idx] = contextRegionBuffer[pxIdx + 2] / 255.0; // B

            if (x >= maskX && x < maskX + maskW && y >= maskY && y < maskY + maskH) {
                maskFloat32[idx] = 1.0;
            } else {
                maskFloat32[idx] = 0.0;
            }
        }
    }

    const imageTensor = new ort.Tensor('float32', imageFloat32, [1, 3, 512, 512]);
    const maskTensor = new ort.Tensor('float32', maskFloat32, [1, 1, 512, 512]);

    const feeds = { image: imageTensor, mask: maskTensor };
    
    logger.info(`🤖 LaMa Inpainting berjalan di area 512x512 (scaled from ${cw}x${ch})...`);
    const results = await sess.run(feeds);
    
    const outName = sess.outputNames[0];
    const outData = results[outName].data; 
    
    const outBuffer = Buffer.alloc(numPixels * 3);
    
    let maxVal = -1000;
    for (let i = 0; i < outData.length; i += 50) {
        if (outData[i] > maxVal) maxVal = outData[i];
    }
    
    let isScale255 = maxVal > 5.0;
    logger.info(`Output maxVal: ${maxVal.toFixed(2)}, isScale255: ${isScale255}`);

    if (isScale255) {
        for (let y = 0; y < 512; y++) {
            for (let x = 0; x < 512; x++) {
                const idx = y * 512 + x;
                const pxIdx = idx * 3;
                outBuffer[pxIdx] = Math.max(0, Math.min(255, Math.round(outData[idx])));
                outBuffer[pxIdx + 1] = Math.max(0, Math.min(255, Math.round(outData[numPixels + idx])));
                outBuffer[pxIdx + 2] = Math.max(0, Math.min(255, Math.round(outData[numPixels * 2 + idx])));
            }
        }
    } else {
        for (let y = 0; y < 512; y++) {
            for (let x = 0; x < 512; x++) {
                const idx = y * 512 + x;
                const pxIdx = idx * 3;
                outBuffer[pxIdx] = Math.max(0, Math.min(255, Math.round(outData[idx] * 255.0)));
                outBuffer[pxIdx + 1] = Math.max(0, Math.min(255, Math.round(outData[numPixels + idx] * 255.0)));
                outBuffer[pxIdx + 2] = Math.max(0, Math.min(255, Math.round(outData[numPixels * 2 + idx] * 255.0)));
            }
        }
    }

    const finalInpaintedBuffer = await sharp(outBuffer, { raw: { width: 512, height: 512, channels: 3 } })
        .resize(cw, ch, { fit: 'fill' }) // Restore back to exact required size
        .png()
        .toBuffer();

    return {
        buffer: finalInpaintedBuffer,
        left: cx,
        top: cy
    };
}

module.exports = {
    inpaintBox
};
