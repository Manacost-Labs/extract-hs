// Клиент локального API (hsserver.py). path_id всегда строка: значения не помещаются в Number.

export type AssetRef = { b: string; p: string; t?: string; n?: string };

export type SearchItem = { b: string; g: string; p: string; t: string; n: string; w: number; h: number };

export type AssetInfo = {
  b: string;
  p: string;
  type: string;
  kind: 'image' | 'audio' | 'video' | 'font' | 'text' | 'data';
  name: string;
  size: number;
  props: Record<string, unknown>;
};

export type Status = {
  state: 'idle' | 'indexing' | 'ready' | 'error' | 'nogame';
  done: number;
  total: number;
  message: string;
  ready: boolean;
  game: string;
  unity: string;
  exportDir: string;
  counts: Record<string, number>;
};

export type ExportResult = { files: string[]; errors: string[]; dir: string };

/** files — первые имена (для тоста), count — сколько записано всего. */
export type ExportJob = ExportResult & {
  id: string;
  state: 'running' | 'done' | 'cancelled';
  done: number;
  total: number;
  count: number;
  skipped: number;
  errorCount: number;
};

/** keep — исходник как в игре; auto — убрать альфу, только если это маска (арт карт). */
export type AlphaMode = 'keep' | 'auto';

/** Экспорт всегда без изменения пикселей: только формат файла (оба без потерь) и альфа-маска. */
export type ImageOpts = { format?: 'png' | 'webp'; alpha?: AlphaMode };

export type ExportItem = AssetRef & { g?: string; crop?: [number, number, number, number]; suffix?: string };

export type ExportBody = {
  items?: ExportItem[];
  query?: SearchQuery;
  bundleAll?: string[];
  opts?: ImageOpts;
  subdir?: string;
  /** tree — раскладка «Категория/группа/имя», как в библиотеке */
  layout?: 'flat' | 'tree';
  skipExisting?: boolean;
  max?: number;
};

export type HierarchyNode = { p: string; n: string; active: boolean; c: { t: string; p: string }[]; children: HierarchyNode[] };

export type SearchQuery = {
  q?: string;
  types?: string;
  groups?: string;
  grp?: string;
  bundle?: string;
  min?: number;
  lang?: string;
  sort?: 'name' | 'size' | 'bundle';
  offset?: number;
  limit?: number;
};

const qs = (params: Record<string, unknown>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '' && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();

async function get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`/api/${path}?${qs(params)}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data as T;
}

export const api = {
  status: () => get<Status>('status'),
  reindex: () => post<{ ok: boolean }>('reindex', {}),
  groups: () => get<{ g: string; bundles: number; assets: number; size: number }[]>('groups'),
  bundles: (g: string) => get<{ b: string; size: number; assets: number }[]>('bundles', { g }),
  types: () => get<{ t: string; count: number }[]>('types'),
  typeGroups: (t: string) => get<{ g: string; count: number }[]>('type_groups', { t }),
  objects: (b: string) => get<{ p: string; t: string; n: string }[]>('objects', { b }),
  search: (q: SearchQuery) => get<{ total: number; items: SearchItem[] }>('search', q),
  info: (a: AssetRef) => get<AssetInfo>('info', { b: a.b, p: a.p }),
  data: (a: AssetRef) => get<unknown>('data', { b: a.b, p: a.p }),
  text: (a: AssetRef) => get<{ text: string; truncated: boolean; length: number }>('text', { b: a.b, p: a.p }),
  export: (body: ExportBody) => post<ExportJob>('export', body),
  exportRaw: (body: { bundles?: string[]; group?: string; all?: boolean; skipExisting?: boolean }) =>
    post<ExportJob>('export_raw', body),
  job: (id: string) => get<ExportJob>('job', { id }),
  jobCancel: (id: string) => post<{ ok: boolean }>('job_cancel', { id }),
  count: (q: SearchQuery) => get<Record<string, number>>('count', q),
  hierarchy: (a: AssetRef) => get<{ b: string; root: HierarchyNode; selected: string; nodes: number }>('hierarchy', { b: a.b, p: a.p }),
  islands: (a: AssetRef) => get<{ width: number; height: number; boxes: [number, number, number, number][] }>('islands', { b: a.b, p: a.p }),
  grid: (a: AssetRef) => get<{ cols: number; rows: number; scoreX: number; scoreY: number }>('grid', { b: a.b, p: a.p }),
  flipbook: (body: Record<string, unknown>) => post<ExportResult>('flipbook', body),
  reveal: (path?: string) => post<{ ok: boolean }>('reveal', { path }),
  settings: (exportDir?: string) => post<{ exportDir: string }>('settings', { exportDir }),
  setGame: (path: string) => post<{ game: string }>('set_game', { path }),
  pickGame: () => post<{ path: string }>('pick_game', {}),
};

export const previewUrl = (a: AssetRef, extra: Record<string, unknown> = {}) =>
  `/api/preview?${qs({ b: a.b, p: a.p, ...extra })}`;

export const thumbUrl = (a: AssetRef, s = 192) => `/api/thumb?${qs({ b: a.b, p: a.p, s })}`;

export const assetKey = (a: AssetRef) => `${a.b}|${a.p}`;

export const TYPE_LABELS: Record<string, string> = {
  Texture2D: 'Текстура',
  Sprite: 'Спрайт',
  AudioClip: 'Звук',
  VideoClip: 'Видео',
  Font: 'Шрифт',
  TextAsset: 'Текст',
  Mesh: 'Меш',
  Shader: 'Шейдер',
  AnimationClip: 'Анимация',
  AnimatorController: 'Аниматор',
  AnimatorOverrideController: 'Аниматор (override)',
  Material: 'Материал',
  MonoBehaviour: 'Скрипт',
  GameObject: 'Объект',
};

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} Б` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} КБ` : n < 1 << 30 ? `${(n / (1 << 20)).toFixed(1)} МБ`
    : `${(n / (1 << 30)).toFixed(1)} ГБ`;
