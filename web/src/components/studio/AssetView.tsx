'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/valyro-ui/basic/Badge';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { SegmentedControl } from '@/components/valyro-ui/navigation/SegmentedControl';
import { api, TYPE_LABELS, type AssetInfo, type AssetRef } from '@/lib/api';
import { Flipbook } from './Flipbook';
import { JsonTree } from './JsonTree';
import { HierarchyView } from './HierarchyView';
import { ImageViewer } from './ImageViewer';
import { MeshViewer } from './MeshViewer';
import { AudioPreview, FontPreview, TextPreview, VideoPreview } from './Previews';
import { TypeIcon } from './icons';

type View = 'preview' | 'data' | 'flipbook' | '3d' | 'hierarchy';

/** Самостоятельные ассеты без иерархии; остальные данные — компоненты префабов. */
const ASSET_DATA_TYPES = new Set(['Material', 'AnimationClip', 'AnimatorController', 'AnimatorOverrideController', 'MonoScript', 'AssetBundle']);

export function useAssetInfo(asset: AssetRef | null) {
  const [info, setInfo] = useState<AssetInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setInfo(null);
    setError('');
    if (asset) api.info(asset).then(setInfo, (e) => setError(e.message));
  }, [asset]);
  return { info, error };
}

function DataView({ asset, onOpen }: { asset: AssetRef; onOpen: (r: AssetRef) => void }) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(undefined);
    api.data(asset).then(setData, (e) => setError(e.message));
  }, [asset]);
  if (error) return <div className="center-fill muted">Ошибка: {error}</div>;
  if (data === undefined) return <div className="center-fill"><Spinner size={20} /></div>;
  return <JsonTree data={data} onOpen={onOpen} />;
}

export function AssetView({ info, error, onOpen }: { info: AssetInfo | null; error: string; onOpen: (r: AssetRef) => void }) {
  const [view, setView] = useState<View>('preview');
  useEffect(() => {
    if (!info) return;
    if (info.type === 'Mesh') setView('3d');
    else if (info.type === 'GameObject') setView('hierarchy');
    else setView(info.kind === 'data' ? 'data' : 'preview');
  }, [info]);

  if (error) return <div className="center-fill muted">Ошибка: {error}</div>;
  if (!info) return <div className="center-fill"><Spinner size={20} /></div>;

  const hasHierarchy = info.kind === 'data' && !ASSET_DATA_TYPES.has(info.type);
  const views = [
    ...(info.type === 'Mesh' ? [{ value: '3d', label: '3D' }] : []),
    ...(hasHierarchy ? [{ value: 'hierarchy', label: 'Иерархия' }] : []),
    ...(info.kind !== 'data' ? [{ value: 'preview', label: info.type === 'Mesh' ? 'OBJ' : 'Превью' }] : []),
    { value: 'data', label: 'Данные' },
    ...(info.kind === 'image' ? [{ value: 'flipbook', label: 'Анимация (флипбук)' }] : []),
  ];

  return (
    <div className="asset-view">
      <div className="asset-header">
        <TypeIcon type={info.type} size={16} />
        <span className="asset-name">{info.name || `${info.type} #${info.p}`}</span>
        <Badge size="sm">{TYPE_LABELS[info.type] ?? info.type}</Badge>
        <span className="muted mono small ellipsis" title={info.b}>{info.b}</span>
        <div className="push-right">
          <SegmentedControl aria-label="Вид" size="sm" value={view} onValueChange={(v) => setView(v as View)} options={views} />
        </div>
      </div>
      <div className="asset-body">
        {view === 'data' && <DataView asset={info} onOpen={onOpen} />}
        {view === '3d' && <MeshViewer info={info} />}
        {view === 'hierarchy' && <HierarchyView info={info} onOpen={onOpen} />}
        {view === 'flipbook' && <Flipbook info={info} />}
        {view === 'preview' && info.kind === 'image' && <ImageViewer info={info} />}
        {view === 'preview' && info.kind === 'audio' && <AudioPreview asset={info} />}
        {view === 'preview' && info.kind === 'video' && <VideoPreview asset={info} />}
        {view === 'preview' && info.kind === 'font' && <FontPreview asset={info} />}
        {view === 'preview' && info.kind === 'text' && <TextPreview info={info} />}
      </div>
    </div>
  );
}
