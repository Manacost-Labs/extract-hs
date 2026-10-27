import type { ExportItem, SearchQuery } from './api';

/** Что скачать из узла дерева, поиска или диалога «Скачать всё». */
export type DownloadAction =
  | { kind: 'query'; query: SearchQuery; label: string; count?: number }
  | { kind: 'bundle'; bundles: string[]; label: string; count?: number }
  | { kind: 'items'; items: ExportItem[]; label: string; count?: number }
  | { kind: 'raw'; bundles?: string[]; group?: string; all?: boolean; label: string; count?: number };
