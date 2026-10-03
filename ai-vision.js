// ============================================================================
// AI Vision — SmolVLM text/table extraction via Hugging Face Transformers.js
// Runs 100% locally in the browser (WebGPU, with WASM fallback). No API keys.
// Model weights are downloaded once and cached by the browser Cache API, so
// subsequent loads are instant.
// ============================================================================
import { AutoProcessor, AutoModelForImageTextToText, RawImage }
    from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.0';

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct'; // ~600 MB; SmolVLM2-2.2B if you want more accuracy

// --- DOM -------------------------------------------------------------------
const btnRun        = document.getElementById('btn-ai-run');
const promptInput   = document.getElementById('ai-prompt');
const deviceBadge   = document.getElementById('ai-device-badge');
const progressWrap  = document.getElementById('ai-progress-wrap');
const progressBar   = document.getElementById('ai-progress-bar');
const progressLabel = document.getElementById('ai-progress-label');
const progressPct   = document.getElementById('ai-progress-detail');
const aiStatus      = document.getElementById('ai-status');
const rawOutput     = document.getElementById('ai-raw-output');
const renderedOut   = document.getElementById('ai-rendered-output');

// --- STATE -----------------------------------------------------------------
let processorPromise = null;   // lazy-init, memoized => cached/instant on 2nd use
let modelPromise = null;
let activeDevice = null;       // 'webgpu' | 'wasm'
let busy = false;

// --- Progress bar helpers ----------------------------------------------------
const fmtBytes = (n) => {
    if (!Number.isFinite(n)) return '?';
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
};

function showProgress(label) {
    progressWrap.classList.add('visible');
    if (label) progressLabel.textContent = label;
    setProgress(0);
}

function setProgress(frac) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    progressBar.style.width = pct + '%';
    progressPct.textContent = pct + '%';
}

function hideProgress() {
    progressWrap.classList.remove('visible');
}

function setStatus(msg, kind = '') {
    aiStatus.className = 'ai-status ' + kind;
    aiStatus.textContent = msg;
}

// Transformers.js progress callback: aggregates per-file download state so the
// bar reflects total bytes across all model shards.
const fileStates = new Map();
function onDownloadProgress(p) {
    if (!p || p.status !== 'progress') return;
    fileStates.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let loaded = 0, total = 0;
    for (const s of fileStates.values()) { loaded += s.loaded; total += s.total; }
    if (total > 0) {
        setProgress(loaded / total);
        progressPct.textContent = `${Math.round((loaded / total) * 100)}%  (${fmtBytes(loaded)} / ${fmtBytes(total)})`;
    } else {
        setProgress(p.progress ?? 0);
    }
}

// --- Device detection & model loading ---------------------------------------
async function tryLoad(device) {
    return AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
        dtype: device === 'webgpu' ? 'q8' : 'fp32',
        device,               // transformers.js v3 device option ('webgpu' | 'wasm')
        progress_callback: onDownloadProgress,
    });
}

async function getModel() {
    if (modelPromise) return modelPromise;

    modelPromise = (async () => {
        showProgress('Downloading SmolVLM (cached after first use)…');
        // Prefer WebGPU; fall back to WASM/CPU transparently.
        let model, lastErr;
        try {
            model = await tryLoad('webgpu');
            activeDevice = 'webgpu';
        } catch (e) {
            console.warn('WebGPU unavailable, falling back to WASM:', e);
            lastErr = e;
            model = await tryLoad('wasm');
            activeDevice = 'wasm';
        }
        hideProgress();
        deviceBadge.textContent = `Device: ${activeDevice.toUpperCase()}${lastErr && activeDevice === 'wasm' ? ' (fallback)' : ''}`;
        deviceBadge.classList.toggle('badge-warn', activeDevice === 'wasm');
        return model;
    })();

    // If the load failed, allow a retry next time.
    modelPromise.catch(() => { modelPromise = null; hideProgress(); });
    return modelPromise;
}

async function getProcessor() {
    if (!processorPromise) {
        processorPromise = AutoProcessor.from_pretrained(MODEL_ID, {
            progress_callback: onDownloadProgress,
        });
        processorPromise.catch(() => { processorPromise = null; });
    }
    return processorPromise;
}

// Kick off device detection badge immediately (non-blocking).
(async () => {
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            deviceBadge.textContent = adapter ? 'Device: WebGPU ready' : 'Device: WASM (no GPU adapter)';
            deviceBadge.classList.toggle('badge-warn', !adapter);
        } catch {
            deviceBadge.textContent = 'Device: WASM';
        }
    } else {
        deviceBadge.textContent = 'Device: WASM (no WebGPU)';
        deviceBadge.classList.add('badge-warn');
    }
})();

// --- Render current PDF page to a high-res image ----------------------------
async function renderPageToCanvas(targetWidthPx = 1600) {
    const hooks = window.__pdfEditor;
    const doc = hooks?.getDoc();
    if (!doc) throw new Error('Upload a PDF first.');

    const pageNumber = hooks.getPage();
    const page = await doc.getPage(pageNumber);

    // High-res: pick a scale that yields ~targetWidthPx output pixels.
    const baseViewport = page.getViewport({ scale: 1 });
    const hiScale = Math.max(2, targetWidthPx / baseViewport.width);
    const viewport = page.getViewport({ scale: hiScale });

    const off = document.createElement('canvas');
    off.width = Math.round(viewport.width);
    off.height = Math.round(viewport.height);
    const octx = off.getContext('2d');

    // White background (PDFs can have transparent regions).
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, off.width, off.height);
    await page.render({ canvasContext: octx, viewport }).promise;
    return off;
}

// --- Minimal Markdown -> HTML renderer (tables, headings, lists, bold/italic/code) ---
function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMd(s) {
    return escapeHtml(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function splitRow(line) {
    return line.replace(/^\||\|\s*$/g, '').split('|').map(c => c.trim());
}

function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function mdToHtml(md) {
    const lines = md.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        // Table block: header row + separator row + body rows
        if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
            const header = splitRow(line);
            const aligns = splitRow(lines[i + 1]).map(sep => {
                const l = sep.startsWith(':'), r = sep.endsWith(':');
                return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
            });
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(splitRow(lines[i]));
                i++;
            }
            const th = header.map((c, j) =>
                `<th${aligns[j] ? ` style="text-align:${aligns[j]}"` : ''}>${inlineMd(c)}</th>`).join('');
            const trs = rows.map(r => {
                const tds = header.map((_, j) =>
                    `<td${aligns[j] ? ` style="text-align:${aligns[j]}"` : ''}>${inlineMd(r[j] ?? '')}</td>`).join('');
                return `<tr>${tds}</tr>`;
            }).join('\n');
            out.push(`<table class="ai-table"><thead><tr>${th}</tr></thead><tbody>\n${trs}\n</tbody></table>`);
            continue;
        }

        // Headings
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        if (h) { out.push(`<h${h[1].length + 1}>${inlineMd(h[2])}</h${h[1].length + 1}>`); i++; continue; }

        // Unordered list items
        if (/^\s*[-*+]\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
                i++;
            }
            out.push(`<ul>${items.join('')}</ul>`);
            continue;
        }

        // Ordered list items
        if (/^\s*\d+\.\s+/.test(line)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                items.push(`<li>${inlineMd(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
                i++;
            }
            out.push(`<ol>${items.join('')}</ol>`);
            continue;
        }

        // Blank line
        if (line.trim() === '') { i++; continue; }

        // Paragraph (gather consecutive non-blank, non-special lines)
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== '' &&
               !lines[i].includes('|') && !/^(#{1,4})\s+/.test(lines[i]) &&
               !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
            para.push(lines[i]);
            i++;
        }
        out.push(`<p>${inlineMd(para.join(' '))}</p>`);
    }
    return out.join('\n');
}

// Strip accidental ```markdown fences around model output
function unwrapFences(text) {
    const m = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
    return m ? m[1] : text;
}

// --- Main extraction flow -----------------------------------------------------
async function runExtraction() {
    if (busy) return;
    busy = true;
    btnRun.disabled = true;
    btnRun.textContent = '⏳ Working…';

    try {
        setStatus('Rendering page to high-res image…');
        const pageCanvas = await renderPageToCanvas();

        // IMPORTANT: transformers.js image processors require a RawImage object
        // (with a `.size` property). Passing a raw <canvas> causes the runtime
        // error "can't access property Symbol.iterator, e.size is undefined".
        const pageImage = await RawImage.fromCanvas(pageCanvas);

        setStatus('Loading model (first run downloads it; later runs are instant)…');
        const [processor, model] = await Promise.all([getProcessor(), getModel()]);

        setStatus(`Running SmolVLM inference on ${activeDevice.toUpperCase()}… this can take 10–90 s.`);
        const messages = [
            { role: 'user', content: [
                { type: 'image' },
                { type: 'text', text: promptInput.value.trim() || 'Extract all text and tables as markdown.' },
            ]},
        ];

        const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
        // Pass the RawImage (not the canvas) — this produces pixel_values,
        // pixel_attention_mask and input_token_type in addition to input_ids.
        const inputs = await processor(text, pageImage);

        // Drop keys the model's session doesn't accept (defensive; e.g. older
        // ONNX exports without input_token_type).
        const allowed = new Set(model.input_names ?? []);
        if (allowed.size > 0) {
            for (const key of Object.keys(inputs)) {
                if (!allowed.has(key)) delete inputs[key];
            }
        }

        const generated = await model.generate({
            ...inputs,
            max_new_tokens: 750,
            do_sample: false,
        });

        // Decode only the newly generated tokens by slicing off the prompt prefix.
        const inputLen = inputs.input_ids.dims.at(-1);
        const decoded = processor.batch_decode(generated.slice(inputLen), {
            skip_special_tokens: true,
        });

        const markdown = unwrapFences((decoded[0] ?? '').trim());
        rawOutput.textContent = markdown || '(empty response)';
        renderedOut.innerHTML = markdown ? mdToHtml(markdown) : '<em>No content returned.</em>';
        setStatus(`Done. Extracted ${markdown.length.toLocaleString()} characters via ${activeDevice.toUpperCase()}.`, 'ok');
    } catch (err) {
        console.error(err);
        setStatus('Error: ' + (err?.message ?? err), 'error');
        hideProgress();
    } finally {
        busy = false;
        btnRun.disabled = false;
        btnRun.textContent = '🤖 Extract with SmolVLM';
    }
}

btnRun.addEventListener('click', runExtraction);
