export interface ShotOptions {
  fullPage: boolean;
  format: 'jpeg' | 'png';
  quality: number;
  maxWidth: number;
}

export interface Shot {
  dataUrl: string;
  width: number;
  height: number;
}

const THROTTLE_MS = 500;
let lastCaptureAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downscale(dataUrl: string, maxWidth: number, format: 'jpeg' | 'png', quality: number): Promise<Shot> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return { dataUrl, width: 0, height: 0 };
  }
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width <= maxWidth) return { dataUrl, width: bitmap.width, height: bitmap.height };
    const height = Math.round((bitmap.height * maxWidth) / bitmap.width);
    const canvas = new OffscreenCanvas(maxWidth, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl, width: bitmap.width, height: bitmap.height };
    ctx.drawImage(bitmap, 0, 0, maxWidth, height);
    const out = await canvas.convertToBlob({ type: `image/${format}`, quality: quality / 100 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return { dataUrl: `data:${out.type};base64,${btoa(binary)}`, width: maxWidth, height };
  } finally {
    bitmap.close();
  }
}

export async function capture(
  tab: { id?: number; windowId?: number; active?: boolean },
  opts: ShotOptions,
  deps: {
    captureVisibleTab: (windowId: number, options: { format: string; quality: number }) => Promise<string>;
    activateTab?: (tabId: number) => Promise<void>;
    fullPageCapture?: (tabId: number, format: 'jpeg' | 'png', quality: number) => Promise<string>;
  },
): Promise<Shot> {
  const tabId = tab.id;
  if (!tab.active && tabId !== undefined && deps.activateTab) {
    await deps.activateTab(tabId);
    await sleep(150);
  }
  const wait = lastCaptureAt + THROTTLE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();
  let raw: string;
  if (opts.fullPage && tabId !== undefined && deps.fullPageCapture) {
    raw = await deps.fullPageCapture(tabId, opts.format, opts.quality);
  } else if (tab.windowId !== undefined) {
    raw = await deps.captureVisibleTab(tab.windowId, { format: opts.format, quality: opts.quality });
  } else {
    throw new Error('no capturable tab (missing window id)');
  }
  return downscale(raw, opts.maxWidth, opts.format, opts.quality);
}
