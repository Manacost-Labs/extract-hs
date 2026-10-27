'use client';

import { useEffect, useState } from 'react';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { ChevronDownIcon, ChevronRightIcon, PackageIcon } from '@/components/valyro-ui/icons';
import { api, type AssetInfo, type AssetRef, type HierarchyNode } from '@/lib/api';
import { TypeIcon } from './icons';

const HIDDEN = new Set(['Transform', 'RectTransform']);

function pathTo(node: HierarchyNode, target: string, acc: string[] = []): string[] | null {
  if (node.p === target) return acc;
  for (const c of node.children) {
    const r = pathTo(c, target, [...acc, node.p]);
    if (r) return r;
  }
  return null;
}

function Node({ node, depth, b, selected, open, toggle, onOpen }: {
  node: HierarchyNode; depth: number; b: string; selected: string; open: Set<string>;
  toggle: (p: string) => void; onOpen: (r: AssetRef) => void;
}) {
  const isOpen = open.has(node.p);
  return (
    <>
      <div className={`h-row ${node.p === selected ? 'selected' : ''} ${node.active ? '' : 'inactive'}`} style={{ paddingLeft: 8 + depth * 16 }}>
        <span className="tree-chevron" onClick={() => toggle(node.p)}>
          {node.children.length ? (isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />) : null}
        </span>
        <button className="h-name" onClick={() => onOpen({ b, p: node.p, t: 'GameObject', n: node.n })}>
          <PackageIcon size={13} /> {node.n || '(без имени)'}
        </button>
        <span className="h-comps">
          {node.c.filter((c) => !HIDDEN.has(c.t)).map((c) => (
            <button key={c.p} className="h-comp" title={`${c.t} #${c.p}`} onClick={() => onOpen({ b, p: c.p, t: c.t })}>
              <TypeIcon type={c.t} size={11} /> {c.t}
            </button>
          ))}
        </span>
      </div>
      {isOpen && node.children.map((c) => (
        <Node key={c.p} node={c} depth={depth + 1} b={b} selected={selected} open={open} toggle={toggle} onOpen={onOpen} />
      ))}
    </>
  );
}

/** Иерархия префаба: объекты и их компоненты, всё кликабельно. */
export function HierarchyView({ info, onOpen }: { info: AssetInfo; onOpen: (r: AssetRef) => void }) {
  const [data, setData] = useState<{ b: string; root: HierarchyNode; selected: string; nodes: number } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    setData(null);
    setError('');
    api.hierarchy(info).then((d) => {
      setData(d);
      const path = pathTo(d.root, d.selected) ?? [];
      const initial = new Set([d.root.p, ...path]);
      // небольшие префабы раскрываем целиком
      if (d.nodes <= 60) {
        const walk = (n: HierarchyNode) => { initial.add(n.p); n.children.forEach(walk); };
        walk(d.root);
      }
      setOpen(initial);
    }, (e) => setError(e.message));
  }, [info]);

  const toggle = (p: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });

  if (error) return <div className="center-fill muted">Иерархия недоступна: {error}</div>;
  if (!data) return <div className="center-fill"><Spinner size={20} /></div>;
  return (
    <div className="hierarchy">
      <div className="muted small pad-x">{data.nodes.toLocaleString('ru-RU')} объектов · клик по имени открывает объект, по компоненту — компонент</div>
      <Node node={data.root} depth={0} b={data.b} selected={data.selected} open={open} toggle={toggle} onOpen={onOpen} />
    </div>
  );
}
