'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VirtualList } from '@/components/valyro-ui/layout/VirtualList';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { ChevronDownIcon, ChevronRightIcon, DownloadIcon, PackageIcon } from '@/components/valyro-ui/icons';
import type { DownloadAction } from '@/lib/download';
import { api, assetKey, TYPE_LABELS, type AssetRef, type SearchItem } from '@/lib/api';
import { groupLabel } from '@/lib/groups';
import { BundleGlyph, FolderGlyph, TypeIcon } from './icons';

type Mode = 'types' | 'files';

type Row = {
  id: string;
  label: string;
  hint?: string;
  depth: number;
  count?: number;
  branch: boolean;
  icon: 'folder' | 'bundle' | 'type' | 'asset' | 'more';
  type?: string;
  asset?: AssetRef & { t: string };
  more?: () => Promise<Row[]>;
  /** скачать содержимое узла */
  dl?: DownloadAction;
  /** скачать исходные файлы бандлов */
  raw?: DownloadAction;
};

const PAGE = 500;

const assetRow = (it: { b: string; p: string; t: string; n: string }, depth: number, prefix = ''): Row => ({
  id: `${prefix}a:${it.b}|${it.p}`,
  label: it.n || `${it.t} #${it.p}`,
  depth,
  branch: false,
  icon: 'asset',
  type: it.t,
  asset: { b: it.b, p: it.p, t: it.t, n: it.n },
});

export function Explorer({
  query,
  activeKey,
  onOpen,
  onDownload,
}: {
  query: string;
  activeKey: string | null;
  onOpen: (a: AssetRef & { t: string }) => void;
  onDownload: (a: DownloadAction) => void;
}) {
  const [mode, setMode] = useState<Mode>('types');
  const [roots, setRoots] = useState<Row[] | null>(null);
  const [children, setChildren] = useState<Record<string, Row[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<{ total: number; items: SearchItem[] } | null>(null);
  const loaders = useRef<Record<string, () => Promise<Row[]>>>({});

  // Корни дерева
  useEffect(() => {
    setRoots(null);
    setChildren({});
    setExpanded(new Set());
    loaders.current = {};
    if (mode === 'types') {
      api.types().then((types) =>
        setRoots(
          types.map((t) => {
            const id = `t:${t.t}`;
            loaders.current[id] = async () =>
              (await api.typeGroups(t.t)).map((g) => {
                const gid = `${id}/g:${g.g}`;
                loaders.current[gid] = () => pagedAssets(gid, { types: t.t, grp: g.g }, 0);
                return { id: gid, label: groupLabel(g.g), hint: g.g, depth: 1, count: g.count, branch: true, icon: 'folder' as const,
                  dl: { kind: 'query' as const, query: { types: t.t, grp: g.g }, label: `${t.t} · ${groupLabel(g.g)}`, count: g.count } };
              });
            const label = TYPE_LABELS[t.t] ? `${TYPE_LABELS[t.t]} · ${t.t}` : t.t;
            return { id, label, depth: 0, count: t.count, branch: true, icon: 'type' as const, type: t.t,
              dl: { kind: 'query' as const, query: { types: t.t }, label, count: t.count } };
          }),
        ),
      );
    } else {
      api.groups().then((groups) =>
        setRoots(
          groups.map((g) => {
            const id = `g:${g.g}`;
            loaders.current[id] = async () =>
              (await api.bundles(g.g)).map((b) => {
                const bid = `${id}/b:${b.b}`;
                loaders.current[bid] = () => bundleObjects(bid, b.b);
                return { id: bid, label: b.b, depth: 1, count: b.assets, branch: true, icon: 'bundle' as const,
                  dl: { kind: 'bundle' as const, bundles: [b.b], label: b.b },
                  raw: { kind: 'raw' as const, bundles: [b.b], label: b.b, count: 1 } };
              });
            return { id, label: groupLabel(g.g), hint: g.g, depth: 0, count: g.bundles, branch: true, icon: 'folder' as const,
              dl: { kind: 'query' as const, query: { grp: g.g }, label: groupLabel(g.g), count: g.assets },
              raw: { kind: 'raw' as const, group: g.g, label: groupLabel(g.g), count: g.bundles } };
          }),
        ),
      );
    }
  }, [mode]);

  const pagedAssets = useCallback(async (parent: string, q: { types: string; grp: string }, offset: number): Promise<Row[]> => {
    const r = await api.search({ ...q, offset, limit: PAGE });
    const rows = r.items.map((it) => assetRow(it, 2, `${parent}/`));
    if (offset + PAGE < r.total) {
      rows.push({
        id: `${parent}/more:${offset}`,
        label: `Показать ещё (${r.total - offset - PAGE})`,
        depth: 2,
        branch: false,
        icon: 'more',
        more: () => pagedAssets(parent, q, offset + PAGE),
      });
    }
    return rows;
  }, []);

  const bundleObjects = useCallback(async (parent: string, bundle: string): Promise<Row[]> => {
    const objs = await api.objects(bundle);
    const byType = new Map<string, typeof objs>();
    for (const o of objs) {
      const list = byType.get(o.t) ?? [];
      list.push(o);
      byType.set(o.t, list);
    }
    return [...byType.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, list]) => {
        const tid = `${parent}/t:${t}`;
        const items = list
          .map((o) => assetRow({ b: bundle, p: o.p, t, n: o.n }, 3, `${tid}/`))
          .sort((a, b) => a.label.localeCompare(b.label));
        loaders.current[tid] = async () => items;
        return { id: tid, label: t, depth: 2, count: list.length, branch: true, icon: 'type' as const, type: t,
          dl: { kind: 'items' as const, items: list.map((o) => ({ b: bundle, p: o.p, t })), label: `${t} · ${bundle}`, count: list.length } };
      });
  }, []);

  const toggle = useCallback(
    async (row: Row) => {
      const open = expanded.has(row.id);
      const next = new Set(expanded);
      if (open) {
        next.delete(row.id);
        setExpanded(next);
        return;
      }
      next.add(row.id);
      setExpanded(next);
      if (!children[row.id] && loaders.current[row.id]) {
        setLoading((s) => new Set(s).add(row.id));
        try {
          const rows = await loaders.current[row.id]();
          setChildren((c) => ({ ...c, [row.id]: rows }));
        } finally {
          setLoading((s) => {
            const n = new Set(s);
            n.delete(row.id);
            return n;
          });
        }
      }
    },
    [expanded, children],
  );

  const loadMore = useCallback(async (row: Row) => {
    if (!row.more) return;
    const parent = row.id.slice(0, row.id.lastIndexOf('/more:'));
    const extra = await row.more();
    setChildren((c) => ({ ...c, [parent]: [...(c[parent] ?? []).filter((r) => r.id !== row.id), ...extra] }));
  }, []);

  // Поиск
  useEffect(() => {
    if (!query.trim()) {
      setResults(null);
      return;
    }
    let cancelled = false;
    api.search({ q: query, limit: 2000 }).then((r) => !cancelled && setResults(r));
    return () => {
      cancelled = true;
    };
  }, [query]);

  const rows = useMemo(() => {
    if (results) return results.items.map((it) => assetRow(it, 0, 's/'));
    const out: Row[] = [];
    const walk = (list: Row[]) => {
      for (const r of list) {
        out.push(r);
        if (r.branch && expanded.has(r.id)) {
          const kids = children[r.id];
          if (kids) walk(kids);
          else out.push({ id: `${r.id}/loading`, label: 'Загрузка…', depth: r.depth + 1, branch: false, icon: 'more' });
        }
      }
    };
    walk(roots ?? []);
    return out;
  }, [roots, children, expanded, results]);

  const activate = (row: Row) => {
    if (row.branch) void toggle(row);
    else if (row.more) void loadMore(row);
    else if (row.asset) onOpen(row.asset);
  };

  const selectedId = rows.find((r) => r.asset && assetKey(r.asset) === activeKey)?.id;

  return (
    <div className="explorer">
      <div className="panel-title">
        <span>{results ? `Поиск · ${results.total.toLocaleString('ru-RU')}` : 'Проводник'}</span>
        {results && results.total > 0 && (
          <button className="row-action" title="Скачать все результаты поиска"
            onClick={() => onDownload({ kind: 'query', query: { q: query }, label: `Поиск «${query}»`, count: results.total })}>
            <DownloadIcon size={13} /> Скачать
          </button>
        )}
        {!results && (
          <SegmentedControl
            aria-label="Вид дерева"
            size="sm"
            value={mode}
            onValueChange={(v) => setMode(v as Mode)}
            options={[
              { value: 'types', label: 'Типы' },
              { value: 'files', label: 'Бандлы' },
            ]}
          />
        )}
      </div>
      {roots === null && !results ? (
        <div className="center-fill"><Spinner size={18} /></div>
      ) : (
        <VirtualList
          items={rows}
          itemSize={24}
          height="100%"
          variant="plain"
          label="Дерево ассетов"
          getItemKey={(r) => r.id}
          selectionMode="single"
          selected={selectedId ? [selectedId] : []}
          onAction={activate}
          empty={<div className="muted pad">Ничего не найдено</div>}
          renderItem={(r) => (
            <div className={`tree-row ${r.icon === 'more' ? 'tree-more' : ''}`} style={{ paddingLeft: 6 + r.depth * 14 }}
              title={r.asset ? `${r.asset.t} · ${r.asset.b}` : r.hint ?? r.label}>
              <span className="tree-chevron">
                {r.branch ? (loading.has(r.id) ? <Spinner size={10} label={null} /> :
                  expanded.has(r.id) ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />) : null}
              </span>
              {r.icon === 'folder' && <FolderGlyph open={expanded.has(r.id)} />}
              {r.icon === 'bundle' && <BundleGlyph />}
              {(r.icon === 'type' || r.icon === 'asset') && r.type && <TypeIcon type={r.type} />}
              <span className="tree-label">{r.label}</span>
              {r.count !== undefined && <span className="tree-count">{r.count.toLocaleString('ru-RU')}</span>}
              {(r.dl || r.raw) && (
                <span className="tree-actions">
                  {r.dl && (
                    <button className="row-action" title="Скачать содержимое" aria-label="Скачать содержимое"
                      onClick={(e) => { e.stopPropagation(); onDownload(r.dl!); }}><DownloadIcon size={12} /></button>
                  )}
                  {r.raw && (
                    <button className="row-action" title="Скачать исходные файлы бандлов (.unity3d)" aria-label="Скачать исходные бандлы"
                      onClick={(e) => { e.stopPropagation(); onDownload(r.raw!); }}><PackageIcon size={12} /></button>
                  )}
                </span>
              )}
            </div>
          )}
        />
      )}
    </div>
  );
}
