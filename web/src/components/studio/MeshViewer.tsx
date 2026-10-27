'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Spinner } from '@/components/valyro-ui/basic/Spinner';
import { Switch } from '@/components/valyro-ui/forms/Switch';
import { Button } from '@/components/valyro-ui/basic/Button';
import { MaximizeIcon } from '@/components/valyro-ui/icons';
import { previewUrl, type AssetInfo } from '@/lib/api';

/** 3D-просмотр меша (OBJ с сервера): вращение, зум, каркас. */
export function MeshViewer({ info }: { info: AssetInfo }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  const [stats, setStats] = useState('');
  const [wire, setWire] = useState(false);
  const api = useRef<{ setWire: (b: boolean) => void; frame: () => void } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x141416);
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / Math.max(1, el.clientHeight), 0.001, 10000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303040, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    scene.add(key);
    const material = new THREE.MeshStandardMaterial({ color: 0xb8b8c0, roughness: 0.65, metalness: 0.05, side: THREE.DoubleSide });
    let object: THREE.Object3D | null = null;

    const frame = () => {
      if (!object) return;
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      const center = box.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(size * 1.1));
      camera.near = size / 1000;
      camera.far = size * 100;
      camera.updateProjectionMatrix();
      key.position.copy(camera.position);
    };
    api.current = { setWire: (b) => { material.wireframe = b; }, frame };

    fetch(previewUrl(info))
      .then((r) => (r.ok ? r.text() : r.json().then((j) => Promise.reject(new Error(j.error)))))
      .then((text) => {
        if (disposed) return;
        object = new OBJLoader().parse(text);
        let verts = 0;
        let tris = 0;
        object.traverse((c) => {
          const m = c as THREE.Mesh;
          if (!m.isMesh) return;
          if (!m.geometry.attributes.normal) m.geometry.computeVertexNormals();
          m.material = material;
          verts += m.geometry.attributes.position.count;
          tris += m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
        });
        scene.add(object);
        frame();
        setStats(`${verts.toLocaleString('ru-RU')} вершин · ${Math.round(tris).toLocaleString('ru-RU')} треугольников`);
        setState('ready');
      })
      .catch((e) => setState(String(e.message ?? e)));

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    const ro = new ResizeObserver(() => {
      renderer.setSize(el.clientWidth, el.clientHeight);
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
      camera.updateProjectionMatrix();
    });
    ro.observe(el);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      material.dispose();
      object?.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [info]);

  useEffect(() => api.current?.setWire(wire), [wire]);

  return (
    <div className="image-preview">
      <div className="toolbar">
        <Switch size="sm" label="Каркас" checked={wire} onCheckedChange={setWire} />
        <Button size="sm" variant="ghost" leftIcon={<MaximizeIcon />} onClick={() => api.current?.frame()}>Вписать</Button>
        <span className="muted small">Мышь: вращение · колесо: зум · правая кнопка: сдвиг</span>
        <span className="muted mono small push-right">{stats}</span>
      </div>
      <div className="mesh-stage" ref={host}>
        {state === 'loading' && <div className="center-fill overlay-center"><Spinner size={20} /></div>}
        {state !== 'loading' && state !== 'ready' && <div className="center-fill overlay-center muted">Ошибка: {state}</div>}
      </div>
    </div>
  );
}
