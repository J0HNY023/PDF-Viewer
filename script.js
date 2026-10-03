pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// --- STATE ---
let pdfLibDoc = null;
let pdfJsDoc = null;
let currentPage = 1;
let scale = 1.5;
let currentMode = 'text';

let isDrawing = false;
let startX = 0, startY = 0;

// --- DOM ---
const fileInput = document.getElementById('pdf-upload');
const canvas = document.getElementById('pdf-canvas');
const ctx = canvas.getContext('2d');
const overlayCanvas = document.getElementById('overlay-canvas');
const overlayCtx = overlayCanvas.getContext('2d');
const pageInfo = document.getElementById('page-info');
const btnDownload = document.getElementById('btn-download');
const btnText = document.getElementById('btn-text');
const btnWhiteout = document.getElementById('btn-whiteout');
const textOptions = document.getElementById('text-options');
const textInput = document.getElementById('toolbar-text-input');
const fontSizeSelect = document.getElementById('font-size-select');
const textColorInput = document.getElementById('text-color');

// --- TOOL SWITCHING ---
btnText.onclick = () => setMode('text');
btnWhiteout.onclick = () => setMode('whiteout');

function setMode(mode) {
    currentMode = mode;
    btnText.classList.toggle('active', mode === 'text');
    btnWhiteout.classList.toggle('active', mode === 'whiteout');
    textOptions.classList.toggle('visible', mode === 'text');
    canvas.style.cursor = mode === 'whiteout' ? 'crosshair' : 'default';
}

// --- FILE UPLOAD ---
fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const arrayBuffer = await file.arrayBuffer();
    pdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer);
    currentPage = 1;
    btnDownload.disabled = false;
    await reloadAndRender();
});

// --- PAGE NAVIGATION ---
document.getElementById('btn-prev').onclick = async () => {
    if (currentPage > 1) { currentPage--; await reloadAndRender(); }
};
document.getElementById('btn-next').onclick = async () => {
    if (pdfJsDoc && currentPage < pdfJsDoc.numPages) { currentPage++; await reloadAndRender(); }
};

// --- RENDER ---
async function reloadAndRender() {
    if (!pdfLibDoc) return;

    const editedBytes = await pdfLibDoc.save();
    pdfJsDoc = await pdfjsLib.getDocument({ data: editedBytes }).promise;

    const page = await pdfJsDoc.getPage(currentPage);
    const viewport = page.getViewport({ scale });

    canvas.height = viewport.height;
    canvas.width = viewport.width;
    overlayCanvas.height = viewport.height;
    overlayCanvas.width = viewport.width;

    await page.render({ canvasContext: ctx, viewport }).promise;
    pageInfo.textContent = `Page ${currentPage} / ${pdfJsDoc.numPages}`;
}

// --- COORDINATE HELPER ---
function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
    };
}

// --- MOUSE EVENTS ---
canvas.addEventListener('mousedown', (e) => {
    if (!pdfJsDoc) return;
    const coords = getCanvasCoords(e);

    if (currentMode === 'whiteout') {
        isDrawing = true;
        startX = coords.x;
        startY = coords.y;
    } else if (currentMode === 'text') {
        // Place text immediately on click
        placeText(coords.x, coords.y);
    }
});

document.addEventListener('mousemove', (e) => {
    if (!isDrawing || currentMode !== 'whiteout') return;
    const coords = getCanvasCoords(e);

    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.save();
    overlayCtx.fillStyle = 'rgba(231, 76, 60, 0.25)';
    overlayCtx.strokeStyle = 'rgba(231, 76, 60, 0.8)';
    overlayCtx.lineWidth = 2;
    overlayCtx.setLineDash([6, 3]);

    const x = Math.min(startX, coords.x);
    const y = Math.min(startY, coords.y);
    const w = Math.abs(coords.x - startX);
    const h = Math.abs(coords.y - startY);

    overlayCtx.fillRect(x, y, w, h);
    overlayCtx.strokeRect(x, y, w, h);
    overlayCtx.restore();
});

document.addEventListener('mouseup', async (e) => {
    if (!isDrawing || currentMode !== 'whiteout') return;
    isDrawing = false;

    const coords = getCanvasCoords(e);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    await handleWhiteout(startX, startY, coords.x, coords.y);
});

// --- TEXT PLACEMENT ---
async function placeText(canvasX, canvasY) {
    const text = textInput.value.trim();
    if (!text) {
        // Flash the input to remind user to type first
        textInput.style.borderColor = '#e74c3c';
        textInput.style.background = '#ffeaea';
        textInput.placeholder = '⚠️ Type something first!';
        setTimeout(() => {
            textInput.style.borderColor = '#3498db';
            textInput.style.background = '#fff';
            textInput.placeholder = 'Type your text here...';
        }, 1500);
        textInput.focus();
        return;
    }

    const fontSize = parseInt(fontSizeSelect.value);
    const colorHex = textColorInput.value;

    // Convert hex color to RGB (0-1 range for pdf-lib)
    const r = parseInt(colorHex.slice(1, 3), 16) / 255;
    const g = parseInt(colorHex.slice(3, 5), 16) / 255;
    const b = parseInt(colorHex.slice(5, 7), 16) / 255;

    const pdfPage = pdfLibDoc.getPages()[currentPage - 1];
    const { height: pdfHeight } = pdfPage.getSize();

    // Convert canvas coords to PDF coords
    const pdfX = canvasX / scale;
    const pdfY = pdfHeight - (canvasY / scale);

    // Draw text onto the PDF
    pdfPage.drawText(text, {
        x: pdfX,
        y: pdfY,
        size: fontSize,
        color: PDFLib.rgb(r, g, b),
    });

    // Show a brief placement marker on the overlay
    showPlacementMarker(canvasX, canvasY);

    // Re-render to show the text on top
    await reloadAndRender();
}

function showPlacementMarker(x, y) {
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 8, 0, Math.PI * 2);
    overlayCtx.fillStyle = 'rgba(46, 204, 113, 0.6)';
    overlayCtx.fill();
    overlayCtx.strokeStyle = '#27ae60';
    overlayCtx.lineWidth = 2;
    overlayCtx.stroke();

    // Crosshair
    overlayCtx.beginPath();
    overlayCtx.moveTo(x - 12, y);
    overlayCtx.lineTo(x + 12, y);
    overlayCtx.moveTo(x, y - 12);
    overlayCtx.lineTo(x, y + 12);
    overlayCtx.strokeStyle = '#27ae60';
    overlayCtx.lineWidth = 1;
    overlayCtx.stroke();
    overlayCtx.restore();

    // Fade out after 600ms
    setTimeout(() => {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }, 600);
}

// --- WHITEOUT ---
async function handleWhiteout(x1, y1, x2, y2) {
    const pdfPage = pdfLibDoc.getPages()[currentPage - 1];
    const { height: pdfHeight } = pdfPage.getSize();

    const pdfX1 = Math.min(x1, x2) / scale;
    const pdfX2 = Math.max(x1, x2) / scale;
    const pdfY1 = pdfHeight - (Math.max(y1, y2) / scale);
    const pdfY2 = pdfHeight - (Math.min(y1, y2) / scale);

    const width = pdfX2 - pdfX1;
    const height = pdfY2 - pdfY1;

    if (width > 2 && height > 2) {
        pdfPage.drawRectangle({
            x: pdfX1,
            y: pdfY1,
            width: width,
            height: height,
            color: PDFLib.rgb(1, 1, 1),
        });
        await reloadAndRender();
    }
}

// --- DOWNLOAD ---
btnDownload.addEventListener('click', async () => {
    if (!pdfLibDoc) return;
    const pdfBytes = await pdfLibDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'edited_document.pdf';
    link.click();
});
