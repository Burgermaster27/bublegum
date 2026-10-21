import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// =====================================================================
//  Рогатка-Лёт — 3D аркадный симулятор самолёта, запускаемого из рогатки
// =====================================================================

const $ = (id) => document.getElementById(id);
const V3 = THREE.Vector3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const hash2 = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FINISH_Z = 3000;
const G = 9.81;
const VALLEY = 105;          // полуширина долины, дальше начинаются горы
const RIVER_Z = 760;
const WATER_Y = -1.6;
const THIN_AIR = 130;
const MAX_AIM_PITCH = 45;       // круче рогатка не запускает        // выше этой высоты воздух разрежается

// =====================================================================
//  Прокачка
// =====================================================================

// Уровни делятся на ступени по 5 — как эпохи у башен в Clash of Clans:
// у ступени свой материал и форма, внутри ступени каждый уровень добавляет детали
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const tierOf = (lv) => (lv <= 0 ? -1 : Math.floor((lv - 1) / 5));
const subOf = (lv) => (lv <= 0 ? 0 : (lv - 1) % 5 + 1);
function makeLevels(start, tiers, max, legend) {
  const out = [start];
  for (let lv = 1; lv <= max; lv++) out.push(lv === max ? legend : `${tiers[tierOf(lv)]} ${ROMAN[subOf(lv)]}`);
  return out;
}
const priceList = (n, base, g) => Array.from({ length: n }, (_, i) => Math.round(base * Math.pow(g, i) / 10) * 10);

const UPG = {
  sling: { icon: '🪃', name: 'Рогатка', costs: priceList(25, 60, 1.16),
    levels: makeLevels('Ветка с резинкой', ['Крепкая', 'Окованная', 'Стальная', 'Королевская', 'Мифриловая'], 25, 'Небесная катапульта'),
    desc: 'Скорость, с которой самолёт вылетает из рогатки.' },
  wings: { icon: '🪽', name: 'Крылья', costs: priceList(25, 120, 1.14),
    levels: makeLevels('Нет крыльев', ['Фанерные', 'Биплан', 'Дюралевые', 'Композитные', 'Карбоновые'], 25, 'Крылья феникса'),
    desc: 'Подъёмная сила и управление по крену. Без крыльев самолёт летит как камень.' },
  tail: { icon: '🛩️', name: 'Хвостовое оперение', costs: priceList(15, 180, 1.2),
    levels: makeLevels('Нет хвоста', ['Деревянный киль', 'Стальное оперение', 'Двойной киль'], 15, 'Оперение аса'),
    desc: 'Устойчивость и управление по тангажу и курсу. Без хвоста самолёт рыскает и кувыркается.' },
  engine: { icon: '🌀', name: 'Двигатель', costs: priceList(25, 380, 1.115),
    levels: makeLevels('Нет двигателя', ['Пропеллер', 'Радиальный мотор', 'Трёхмоторный', 'Импеллеры', 'Реактивный'], 25, 'Ракетный ускоритель'),
    desc: 'Тяга и максимальная скорость. Первый уровень — пропеллер, он открывает топливо.' },
  fuel: { icon: '⛽', name: 'Топливный бак', req: 'engine', costs: priceList(10, 200, 1.3),
    levels: ['Фляжка', 'Канистра', 'Две канистры', 'Бак', 'Бак с насосом', 'Большой бак', 'Подвесной бак', 'Два подвесных бака', 'Крыльевые баки', 'Цистерна', 'Мега-цистерна'],
    desc: 'Сколько секунд может работать двигатель.' },
  aero: { icon: '🧪', name: 'Обтекаемость', costs: priceList(15, 220, 1.18),
    levels: makeLevels('Коробка', ['Обтекатель', 'Гладкий фюзеляж', 'Аэродинамика PRO'], 15, 'Хромированный болид'),
    desc: 'Снижает сопротивление воздуха — дальше летишь, меньше теряешь скорость.' },
  gear: { icon: '🛞', name: 'Шасси', costs: [300, 1500, 7500],    // каждое следующее в 5 раз дороже
    levels: ['Посадка на брюхо', 'Колёса', 'Хромированное шасси', 'Золотое шасси'],
    desc: 'Мягкие посадки: самолёт катится по земле, а не пашет её брюхом. Чем лучше шасси, тем дальше катится.' },
};
const UPG_ORDER = ['sling', 'wings', 'tail', 'engine', 'fuel', 'aero', 'gear'];

const SAVE_KEY = 'slingplane-save-v1';
const defaultSave = () => ({
  ver: 2, money: 0, best: 0, flights: 0, finishes: 0, invert: false, sound: true, quality: 'medium', showFps: false,
  lv: { sling: 0, wings: 0, tail: 0, engine: 0, fuel: 0, aero: 0, gear: 0 },
});
let save = defaultSave();
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) {
    const s = JSON.parse(raw);
    if (!s.ver) {
      // Перевод старой прокачки (короткие шкалы) на новые 15/25 уровней примерно той же силы
      const o = s.lv || {};
      const oldThrust = o.prop > 0 ? [0, 4.6, 6.0][o.prop] * [1, 1.3, 1.62, 1.95, 2.35][o.engine || 0] : 0;
      s.lv = {
        sling: Math.min(25, (o.sling || 0) * 5),
        wings: [0, 3, 12, 21][o.wings || 0],
        tail: [0, 4, 12][o.tail || 0],
        engine: oldThrust ? clamp(Math.round((oldThrust - 4.4) / 11 * 24) + 1, 1, 25) : 0,
        fuel: [0, 2, 4, 6, 9][o.fuel || 0],
        aero: [0, 5, 10, 14][o.aero || 0],
        gear: o.gear || 0,
      };
      s.ver = 2;
    }
    save = { ...defaultSave(), ...s, lv: { ...defaultSave().lv, ...(s.lv || {}) } };
    delete save.lv.prop;
    for (const k of UPG_ORDER) save.lv[k] = clamp(save.lv[k] | 0, 0, UPG[k].costs.length);
  }
} catch (e) { /* без сохранений */ }
if (!['low', 'medium', 'high'].includes(save.quality)) save.quality = 'medium';
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* ignore */ } }

const wingSpan = (lv) => (lv > 0 ? 4.6 + (lv - 1) * 0.12 : 0);
// Характеристики самолёта плавно растут с уровнем; на максимуме чуть сильнее прежних максимальных
function computeStats(L) {
  const w = L.wings, wt = w > 0 ? (w - 1) / 24 : 0;
  const t = L.tail, tt = t > 0 ? (t - 1) / 14 : 0;
  const e = L.engine, et = e > 0 ? (e - 1) / 24 : 0;
  const a = L.aero / 15;
  return {
    launch: 30 + L.sling * 1.8,
    liftK: w ? 0.025 + wt * 0.013 : 0,
    cd0: 0.0010 * (1 - a * 0.5) + (w ? 0.00036 - wt * 0.00008 : 0) + (t ? 0.00008 + tt * 0.00003 : 0),
    sideK: 0.003 + (t ? 0.003 + tt * 0.0015 : 0),
    pitchStab: t ? 0.055 + tt * 0.025 : 0.010,
    yawStab: t ? 0.036 + tt * 0.016 : 0.006,
    pitchCtrl: (t ? 0.009 + tt * 0.006 : 0.0018) + (w ? 0.0012 : 0),
    pitchBase: t ? 1.4 + tt * 0.9 : 0.7,
    yawCtrl: t ? 0.0035 + tt * 0.003 : 0.0008,
    yawBase: t ? 0.75 + tt * 0.5 : 0.35,
    rollCtrl: w ? 0.012 + wt * 0.008 : 0.0008,
    rollBase: w ? 1.4 + wt * 1.2 : 0.4,
    pitchDamp: t ? 0.17 + tt * 0.04 : 0.05,
    yawDamp: t ? 0.14 + tt * 0.05 : 0.04,
    rollDamp: w ? 0.24 + wt * 0.07 : 0.02,
    wobble: t ? 0.55 - tt * 0.45 : 3.2,
    levelK: w ? 1.4 : 0,
    turnK: w ? 1.6 : 0,
    align: (w ? 0.42 + wt * 0.26 : 0.06) + (t ? 0.07 + tt * 0.06 : 0),
    thrust: e ? 4.4 + et * 11 : 0,
    propVmax: e ? 50 + et * 60 : 0,
    fuel: e ? Math.round((6 + L.fuel * 2.4) * 10) / 10 : 0,
    gear: L.gear > 0,
    rollFr: [0, 2.2, 1.3, 0.75][L.gear],      // сопротивление качению: лучше шасси — дольше пробег
    span: wingSpan(w),
  };
}
let S = computeStats(save.lv);

// =====================================================================
//  Рендер, сцена, свет
// =====================================================================

const renderer = new THREE.WebGLRenderer({ antialias: save.quality === 'high', powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const SKY_BOTTOM = new THREE.Color(0xcfe6f7);
scene.fog = new THREE.Fog(SKY_BOTTOM, 260, 1100);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 2600);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(900, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(0x3d86d4) }, bottom: { value: SKY_BOTTOM }, sun: { value: new V3(0.45, 0.55, 0.7).normalize() } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sun; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = max(d.y, 0.0);
        vec3 c = mix(bottom, top, pow(h, 0.55));
        float s = max(dot(d, sun), 0.0); c += vec3(1.0,0.9,0.7) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(c, 1.0); }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x5a6b3a, 0.9));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);
const SUN_OFFSET = new V3(60, 110, 85);

const matCache = new Map();
function std(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0, ...opts }));
  return matCache.get(key);
}
function mesh(geo, mat, x = 0, y = 0, z = 0, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}
function jitter(geo, amount, seed) {
  const r = rng(seed);
  const p = geo.attributes.position;
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(2)},${p.getY(i).toFixed(2)},${p.getZ(i).toFixed(2)}`;
    if (!map.has(k)) map.set(k, [(r() - 0.5) * amount, (r() - 0.5) * amount, (r() - 0.5) * amount]);
    const d = map.get(k);
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

// =====================================================================
//  Рельеф
// =====================================================================

function riverDip(z) { const d = Math.abs(z - RIVER_Z); return d < 32 ? (1 - smooth(9, 32, d)) * 5.5 : 0; }
function terrainH(x, z) {
  let h = 2.2 * Math.sin(x * 0.031 + 1.3) * Math.cos(z * 0.019) + 1.6 * Math.sin(z * 0.012 + x * 0.008) + 0.7 * Math.sin(x * 0.13 + z * 0.09);
  const ax = Math.abs(x);
  if (ax > VALLEY) {
    const d = ax - VALLEY;
    h += 125 * (1 - Math.exp(-d / 55)) + d * 0.08 + 7 * Math.sin(z * 0.023 + x * 0.05) * Math.min(1, d / 25) + 14 * Math.sin(z * 0.007 + x * 0.02) * Math.min(1, d / 60);
  }
  h *= smooth(25, 90, Math.hypot(x * 0.8, z));
  h -= riverDip(z) * (1 - smooth(VALLEY - 5, VALLEY + 25, ax));
  return h;
}
const roadBase = (z) => 22 * Math.sin(z * 0.0035) + 9 * Math.sin(z * 0.011 + 1);
// Возле реки дорога выпрямляется и идёт ровно по мосту
const BRIDGE_X = roadBase(RIVER_Z), BRIDGE_HALF_LEN = 40;
const roadX = (z) => lerp(roadBase(z), BRIDGE_X, 1 - smooth(BRIDGE_HALF_LEN + 5, BRIDGE_HALF_LEN + 70, Math.abs(z - RIVER_Z)));
// Высота настила: пологая арка над водой, к краям плавно садится на берег (это и есть въезды)
function bridgeDeckY(z) {
  const dz = Math.abs(z - RIVER_Z);
  return Math.max(terrainH(BRIDGE_X, z) + 0.15, 1.3 - 0.0028 * dz * dz);
}

function fieldColor(x, z, out) {
  const ax = Math.abs(x);
  if (ax < 16 || ax > 96 || z < 60 || Math.abs(z - RIVER_Z) < 40) return false;
  const cz = Math.floor(z / 70), cx = Math.floor((ax - 16) / 27), side = x > 0 ? 1 : 0;
  const k = hash2(cz * 3.1 + side * 17.7, cx * 7.3);
  if (k < 0.42) return false;
  const stripe = 0.92 + 0.08 * Math.sin(z * 0.9);
  if (k < 0.58) out.setRGB(0.86 * stripe, 0.74 * stripe, 0.32 * stripe);
  else if (k < 0.72) out.setRGB(0.47 * stripe, 0.34 * stripe, 0.21 * stripe);
  else if (k < 0.86) out.setRGB(0.40 * stripe, 0.66 * stripe, 0.24 * stripe);
  else out.setRGB(0.58 * stripe, 0.48 * stripe, 0.74 * stripe);
  return true;
}

const W_TERRAIN = 720;
function buildTerrain() {
  // Рельеф нарезан на участки по 375 м, чтобы невидимые куски отсекались камерой
  const Z0 = -320, LEN = 375;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  for (let k = 0; k < 10; k++) buildTerrainChunk(Z0 + k * LEN, LEN, mat);
  buildRoadAndWater();
}
function buildTerrainChunk(z0, len, mat) {
  const W = W_TERRAIN;
  const geo = new THREE.PlaneGeometry(W, len, 180, Math.round(len / 5));
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i) + z0 + len / 2;
    const h = terrainH(x, z);
    p.setY(i, h); p.setZ(i, z);
    const n = hash2(Math.floor(x / 6), Math.floor(z / 6));
    const ax = Math.abs(x);
    if (!fieldColor(x, z, c)) c.setRGB(0.33 + n * 0.08, 0.56 + n * 0.08, 0.22 + n * 0.04);
    const slope = Math.abs(terrainH(x + 2, z) - h) + Math.abs(terrainH(x, z + 2) - h);
    const rock = smooth(2.2, 4.2, slope) * smooth(VALLEY - 5, VALLEY + 15, ax);
    c.lerp(new THREE.Color(0.47 + n * 0.08, 0.45 + n * 0.06, 0.42), rock);
    c.lerp(new THREE.Color(0.95, 0.97, 1.0), smooth(105, 125, h + n * 10));
    if (riverDip(z) > 0.3 && ax < VALLEY + 15) c.lerp(new THREE.Color(0.55, 0.5, 0.36), smooth(0.3, 2.5, riverDip(z)));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, mat);
  m.receiveShadow = true;
  scene.add(m);
}
function buildRoadAndWater() {
  const W = W_TERRAIN;

  // Дорога — лента поверх рельефа
  const pts = [], idx = [];
  for (let z = -60, i = 0; z <= 3300; z += 4, i++) {
    const x = roadX(z);
    for (const s of [-2.8, 2.8]) pts.push(x + s, terrainH(x + s, z) + 0.12, z);
    // на мосту дорогу заменяет настил
    if (i > 0 && Math.abs(z - 2 - RIVER_Z) > BRIDGE_HALF_LEN - 3) { const a = (i - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  rg.setIndex(idx);
  rg.computeVertexNormals();
  const road = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ color: 0xb59a6a, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
  road.receiveShadow = true;
  scene.add(road);

  // Река
  const water = new THREE.Mesh(new THREE.PlaneGeometry(W, 46), new THREE.MeshStandardMaterial({ color: 0x3a8fc9, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, WATER_Y, RIVER_Z);
  water.receiveShadow = true;
  scene.add(water);
}

// =====================================================================
//  Препятствия, монеты, кольца
// =====================================================================

const obstacles = [];   // { zMin, zMax, prims: [...], update?(t) }
const movers = [];      // объекты с анимацией
const coins = [];       // { pos, taken }
const rings = [];       // { c, R, mesh, taken }
const treeList = [];
const world = new THREE.Group();
scene.add(world);
const statics = new THREE.Group();
scene.add(statics);

function addObstacle(prims, update, margin = 0) {
  let zMin = Infinity, zMax = -Infinity;
  for (const p of prims) {
    let z0, z1;
    if (p.t === 'cyl') { z0 = p.z - p.r; z1 = p.z + p.r; }
    else if (p.t === 'cone') { z0 = p.z - p.r0; z1 = p.z + p.r0; }
    else if (p.t === 'sph') { z0 = p.c.z - p.r; z1 = p.c.z + p.r; }
    else if (p.t === 'box') { z0 = p.min.z; z1 = p.max.z; }
    else if (p.t === 'seg') { z0 = Math.min(p.a.z, p.b.z) - p.r - 20; z1 = Math.max(p.a.z, p.b.z) + p.r + 20; }
    else if (p.t === 'torus') { z0 = p.c.z - p.r; z1 = p.c.z + p.r; }
    zMin = Math.min(zMin, z0); zMax = Math.max(zMax, z1);
  }
  const o = { zMin: zMin - margin, zMax: zMax + margin, prims, update };
  obstacles.push(o);
  if (update) movers.push(o);
  return o;
}

function addTree(x, z, s, pine) {
  const y = terrainH(x, z);
  treeList.push({ x, y, z, s, pine, rot: hash2(x, z) * 6.28 });
  // Хитбокс повторяет форму модели: ствол + конусы ели или шар кроны лиственного дерева
  const b = y - 0.2;
  const trunk = { t: 'cyl', x, z, r: 0.42 * s, y0: b - 1, y1: b + 3 * s };
  if (pine) {
    addObstacle([trunk,
      { t: 'cone', x, z, r0: 2.0 * s, y0: b + 2.5 * s, y1: b + 7.5 * s },
      { t: 'cone', x, z, r0: 1.55 * s, y0: b + 5.8 * s, y1: b + 9.8 * s }]);
  } else {
    addObstacle([trunk, { t: 'sph', c: new V3(x, b + 5.8 * s, z), r: 2.45 * s }]);
  }
}
function addDecorTree(x, z, s, pine) { treeList.push({ x, y: terrainH(x, z), z, s, pine, rot: hash2(x, z) * 6.28 }); }

// Инстансы раскладываются по участкам трассы — дальние участки не рисуются
const INST_CHUNK = 400;
function chunkedInstances(parent, geo, mat, items, shadow = true) {
  const byChunk = new Map();
  for (const it of items) { const k = Math.floor(it.z / INST_CHUNK); if (!byChunk.has(k)) byChunk.set(k, []); byChunk.get(k).push(it); }
  for (const list of byChunk.values()) {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((it, i) => { im.setMatrixAt(i, it.m); if (it.c) im.setColorAt(i, it.c); });
    im.castShadow = shadow; im.receiveShadow = true;
    im.computeBoundingSphere();
    parent.add(im);
  }
}
function buildTrees() {
  const trunkG = new THREE.CylinderGeometry(0.3, 0.45, 3, 6); trunkG.translate(0, 1.5, 0);
  const pineG = new THREE.ConeGeometry(2.2, 5, 7); pineG.translate(0, 5.0, 0);
  const pine2G = new THREE.ConeGeometry(1.7, 4, 7); pine2G.translate(0, 7.8, 0);
  const roundG = new THREE.IcosahedronGeometry(2.8, 0); roundG.translate(0, 5.8, 0);
  const trunks = [], pines = [], rounds = [];
  const q = new THREE.Quaternion(), sc = new V3(), pos = new V3();
  for (const t of treeList) {
    q.setFromAxisAngle(_yAxis, t.rot);
    pos.set(t.x, t.y - 0.2, t.z); sc.setScalar(t.s);
    const m = new THREE.Matrix4().compose(pos, q, sc);
    trunks.push({ m, z: t.z });
    if (t.pine) pines.push({ m, z: t.z, c: new THREE.Color().setHSL(0.33 + hash2(t.x, 3) * 0.06, 0.45, 0.25 + hash2(t.z, 1) * 0.08) });
    else rounds.push({ m, z: t.z, c: new THREE.Color().setHSL(0.24 + hash2(t.x, 5) * 0.1, 0.5, 0.33 + hash2(t.z, 2) * 0.1) });
  }
  chunkedInstances(scene, trunkG, std(0x6b4a2b), trunks);
  chunkedInstances(scene, pineG, std(0xffffff), pines);
  chunkedInstances(scene, pine2G, std(0xffffff), pines);
  chunkedInstances(scene, roundG, std(0xffffff), rounds);
}

function addRock(x, z, s, seed) {
  const y = terrainH(x, z);
  const g = jitter(new THREE.DodecahedronGeometry(s, 0), s * 0.35, seed);
  const m = mesh(g, std(0x8b8682), x, y + s * 0.45, z);
  m.rotation.set(hash2(x, 1) * 3, hash2(z, 2) * 3, 0);
  statics.add(m);
  addObstacle([{ t: 'sph', c: new V3(x, y + s * 0.45, z), r: s * 0.95 }]);
}

function addPillar(x, z, r, H, seed) {
  const y = terrainH(x, z) - 2;
  const g = jitter(new THREE.CylinderGeometry(r * 0.72, r, H, 8, 4), r * 0.35, seed);
  const m = mesh(g, std(0x9a8170), x, y + H / 2, z);
  statics.add(m);
  const cap = mesh(jitter(new THREE.CylinderGeometry(r * 0.8, r * 0.74, 1.6, 8), 0.5, seed + 1), std(0x5d9a3a), x, y + H + 0.5, z);
  statics.add(cap);
  if (r > 4) for (let i = 0; i < 2; i++) { const a = hash2(seed, i) * 6.28; addDecorTreeMesh(x + Math.cos(a) * r * 0.35, y + H + 1, z + Math.sin(a) * r * 0.35, 0.55); }
  addObstacle([{ t: 'cyl', x, z, r: r * 0.95, y0: y - 5, y1: y + H + 2 }]);
}
function addDecorTreeMesh(x, y, z, s) { treeList.push({ x, y, z, s, pine: true, rot: 0 }); }

const bladeGeo = (() => { const g = new THREE.BoxGeometry(1.1, 16, 0.25); g.translate(0, 8.4, 0); const p = g.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) > 10) p.setX(i, p.getX(i) * 0.45); g.computeVertexNormals(); return g; })();
function addTurbine(x, z, H, speed, phase) {
  const y = terrainH(x, z);
  const tower = mesh(new THREE.CylinderGeometry(0.75, 1.35, H, 10), std(0xf1f3f5), x, y + H / 2, z);
  statics.add(tower);
  const nac = mesh(new THREE.BoxGeometry(2.2, 2.2, 5), std(0xe3e7ea), x, y + H, z + 0.8);
  statics.add(nac);
  const rotor = new THREE.Group();
  rotor.position.set(x, y + H, z - 1.9);
  rotor.add(mesh(new THREE.ConeGeometry(1.1, 2, 10).rotateX(-Math.PI / 2), std(0xd94a3a)));
  for (let i = 0; i < 3; i++) { const b = mesh(bladeGeo, std(0xfafafa)); b.rotation.z = i * Math.PI * 2 / 3; rotor.add(b); const tip = mesh(new THREE.BoxGeometry(0.55, 2.2, 0.27), std(0xd94a3a)); tip.position.y = 15.3; b.add(tip); }
  world.add(rotor);
  mergeStatic(rotor, 0);
  const hub = new V3(x, y + H, z - 1.9);
  const segs = [0, 1, 2].map(() => ({ t: 'seg', a: hub.clone(), b: hub.clone(), r: 0.75 }));
  addObstacle([{ t: 'cyl', x, z, r: 1.4, y0: y - 1, y1: y + H }, { t: 'sph', c: new V3(x, y + H, z + 0.5), r: 2.4 }, ...segs], (t) => {
    const a0 = phase + t * speed;
    rotor.rotation.z = a0;
    for (let i = 0; i < 3; i++) {
      const a = a0 + i * Math.PI * 2 / 3;
      segs[i].b.set(hub.x - Math.sin(a) * 16.5, hub.y + Math.cos(a) * 16.5, hub.z);
    }
  }, 2);
}

function stripedSphere(r, colA, colB, stripes) {
  const g = new THREE.SphereGeometry(r, stripes * 2, 12).toNonIndexed();
  const p = g.attributes.position, cols = new Float32Array(p.count * 3);
  const a = new THREE.Color(colA), b = new THREE.Color(colB);
  for (let i = 0; i < p.count; i += 3) {
    const cx = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, cz = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    const k = Math.floor((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2) * stripes * 2) % 2;
    const c = k ? a : b;
    for (let j = 0; j < 3; j++) cols.set([c.r, c.g, c.b], (i + j) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

const BALLOON_COLORS = [[0xe74c3c, 0xf1c40f], [0x3498db, 0xffffff], [0x9b59b6, 0xf39c12], [0x2ecc71, 0xf9e79f], [0xe67e22, 0x34495e]];
function addBalloon(x, z, baseY, phase, ci) {
  const gy = terrainH(x, z) + baseY;
  const grp = new THREE.Group();
  const env = mesh(stripedSphere(7, ...BALLOON_COLORS[ci % BALLOON_COLORS.length], 6), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.7 }));
  env.scale.set(1, 1.15, 1);
  grp.add(env);
  const neck = mesh(new THREE.CylinderGeometry(2.4, 1.2, 3, 10), std(0x7a3b2e), 0, -8.4, 0); grp.add(neck);
  const basket = mesh(new THREE.BoxGeometry(2.2, 1.6, 2.2), std(0x9c6b3c), 0, -12.6, 0); grp.add(basket);
  const ropeMat = std(0x3b2b1b);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const r = mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 4), ropeMat, sx * 1.0, -10.6, sz * 1.0); r.rotation.set(sz * 0.08, 0, -sx * 0.08); grp.add(r);
  }
  grp.position.set(x, gy, z);
  world.add(grp);
  mergeStatic(grp, 0);
  const c = new V3(x, gy, z), cb = new V3(x, gy - 12.6, z);
  const prims = [{ t: 'sph', c, r: 7.3 }, { t: 'sph', c: cb, r: 1.7 }];
  addObstacle(prims, (t) => {
    const y = gy + Math.sin(t * 0.55 + phase) * 6;
    grp.position.y = y; c.y = y; cb.y = y - 12.6;
    grp.rotation.y = t * 0.1 + phase;
  }, 2);
}

function addBlimp(x, z, y, amp, phase) {
  const grp = new THREE.Group();
  const body = mesh(new THREE.SphereGeometry(6, 20, 12), std(0xc9ced6, { metalness: 0.25, roughness: 0.5, flatShading: false }));
  body.scale.set(2.3, 1, 1); grp.add(body);
  const band = mesh(new THREE.CylinderGeometry(6.05, 6.05, 3, 20, 1, true).rotateZ(Math.PI / 2), std(0xd94a3a, { side: THREE.DoubleSide }), 0, 0, 0); band.scale.set(1, 1, 1); grp.add(band);
  const gond = mesh(new THREE.BoxGeometry(6, 2, 2.4), std(0x34495e), 0, -6.6, 0); grp.add(gond);
  for (const [ry, rz] of [[0, 0], [0, Math.PI / 2], [0, Math.PI], [0, -Math.PI / 2]]) {
    const f = mesh(new THREE.BoxGeometry(4, 0.3, 3.5), std(0xd94a3a)); f.position.set(-12.5, 0, 0);
    const holder = new THREE.Group(); holder.rotation.set(rz, ry, 0); f.position.set(-12.5, 3.2, 0); f.rotation.x = Math.PI / 2; holder.add(f); grp.add(holder);
  }
  grp.position.set(x, y, z);
  world.add(grp);
  mergeStatic(grp, 0);
  const cs = [-8, 0, 8].map(() => new V3(x, y, z));
  const gc = new V3(x, y - 6.6, z);
  addObstacle([...cs.map((c) => ({ t: 'sph', c, r: 5.6 })), { t: 'sph', c: gc, r: 2.2 }], (t) => {
    const s = Math.sin(t * 0.22 + phase), cx = x + s * amp;
    grp.position.x = cx;
    grp.rotation.y = Math.cos(t * 0.22 + phase) >= 0 ? 0 : Math.PI;
    cs.forEach((c, i) => { c.x = cx + (i - 1) * 8; });
    gc.x = cx;
  }, 2);
}

function addFloatingRock(x, z, y, s, seed) {
  const grp = new THREE.Group();
  const g = jitter(new THREE.DodecahedronGeometry(s, 1), s * 0.3, seed);
  const rock = mesh(g, std(0x8d7f73));
  rock.scale.y = 0.7;
  grp.add(rock);
  const grass = mesh(jitter(new THREE.CylinderGeometry(s * 0.85, s * 0.7, s * 0.25, 9), s * 0.12, seed + 3), std(0x5a9c3a), 0, s * 0.62, 0);
  grp.add(grass);
  const under = mesh(jitter(new THREE.ConeGeometry(s * 0.6, s * 1.4, 7), s * 0.2, seed + 7).rotateX(Math.PI), std(0x7a6c61), 0, -s * 0.9, 0);
  grp.add(under);
  grp.position.set(x, y, z);
  world.add(grp);
  mergeStatic(grp, 0);
  for (let i = 0; i < 2; i++) treeList.push({ x: x + (hash2(seed, i) - 0.5) * s, y: y + s * 0.7, z: z + (hash2(i, seed) - 0.5) * s, s: 0.45, pine: true, rot: 0 });
  const c = new V3(x, y, z);
  addObstacle([{ t: 'sph', c, r: s * 0.92 }, { t: 'sph', c: new V3(x, y - s * 0.9, z), r: s * 0.5 }], (t) => {
    grp.rotation.y = t * 0.05 + seed;
  });
}

function addPowerLine(z) {
  const xs = [-112, -64, -16, 32, 80, 120];
  const tops = [];
  const mDark = std(0x5c6670, { metalness: 0.4, roughness: 0.6 });
  const prims = [];
  for (const x of xs) {
    const y = terrainH(x, z);
    const H = 32;
    const tower = mesh(new THREE.CylinderGeometry(0.45, 2.2, H, 4, 1), mDark, x, y + H / 2, z); tower.rotation.y = Math.PI / 4; statics.add(tower);
    const arm = mesh(new THREE.BoxGeometry(11, 0.7, 0.7), mDark, x, y + H - 4, z); statics.add(arm);
    const arm2 = mesh(new THREE.BoxGeometry(7, 0.6, 0.6), mDark, x, y + H - 0.5, z); statics.add(arm2);
    tops.push([new V3(x - 5.2, y + H - 4.5, z), new V3(x + 5.2, y + H - 4.5, z), new V3(x, y + H + 0.2, z)]);
    prims.push({ t: 'cyl', x, z, r: 2.0, y0: y - 1, y1: y + H + 1 }, { t: 'box', min: new V3(x - 5.6, y + H - 4.6, z - 0.6), max: new V3(x + 5.6, y + H - 3.4, z + 0.6) });
  }
  const cableMat = std(0x222222);
  const unit = new THREE.CylinderGeometry(0.09, 0.09, 1, 4);
  for (let i = 0; i < xs.length - 1; i++) {
    for (let k = 0; k < 3; k++) {
      const a = tops[i][k], b = tops[i + 1][k];
      const N = 6; let prev = a.clone();
      for (let j = 1; j <= N; j++) {
        const t = j / N;
        const p = a.clone().lerp(b, t); p.y -= 4 * Math.sin(Math.PI * t);
        const d = p.clone().sub(prev), len = d.length();
        const cm = new THREE.Mesh(unit, cableMat);
        cm.scale.y = len; cm.position.copy(prev).addScaledVector(d, 0.5); cm.quaternion.setFromUnitVectors(new V3(0, 1, 0), d.normalize());
        statics.add(cm);
        prev = p;
      }
    }
  }
  addObstacle(prims);
}

function addWall(z, gaps, seed) {
  const X0 = -175, X1 = 175, TOP = 92, BOT = -8, TH = 9;
  const boxes = [];
  const sorted = [...gaps].sort((a, b) => a.x - b.x);
  let cur = X0;
  for (const gp of sorted) {
    const g0 = gp.x - gp.w / 2, g1 = gp.x + gp.w / 2;
    boxes.push([cur, g0, BOT, TOP]);
    boxes.push([g0, g1, BOT, gp.y0]);
    boxes.push([g0, g1, gp.y1, TOP]);
    cur = g1;
  }
  boxes.push([cur, X1, BOT, TOP]);
  const prims = [];
  let i = 0;
  for (const [x0, x1, y0, y1] of boxes) {
    if (y1 - y0 < 0.5) continue;
    const w = x1 - x0, h = y1 - y0;
    const g = jitter(new THREE.BoxGeometry(w, h, TH, Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(h / 6)), 2), 2.2, seed + i++);
    const m = mesh(g, std(0x9b8574), (x0 + x1) / 2, (y0 + y1) / 2, z);
    statics.add(m);
    prims.push({ t: 'box', min: new V3(x0 + 0.4, y0, z - TH / 2 + 0.4), max: new V3(x1 - 0.4, y1, z + TH / 2 - 0.4) });
  }
  // Кромка из травы и деревья сверху
  const top = mesh(jitter(new THREE.BoxGeometry(X1 - X0, 1.2, TH + 1, 30, 1, 2), 1.2, seed + 99), std(0x5f9a3c), 0, TOP + 0.3, z);
  statics.add(top);
  for (let k = 0; k < 18; k++) addDecorTreeMesh(X0 + 10 + k * 19 + hash2(seed, k) * 6, TOP + 0.6, z + (hash2(k, seed) - 0.5) * 5, 0.6 + hash2(k, k) * 0.4);
  // Подсветка проёмов — флажки по углам
  for (const gp of gaps) {
    for (const sx of [-1, 1]) for (const yy of [gp.y0, gp.y1]) {
      const f = mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), std(0xffd23d, { emissive: 0x806000 }), gp.x + sx * gp.w / 2, yy, z - TH / 2 - 0.5);
      statics.add(f);
    }
  }
  addObstacle(prims);
}

function addHouse(x, z, rot, seed) {
  const y = terrainH(x, z);
  const r = rng(seed);
  const w = 6 + r() * 4, d = 7 + r() * 5, h = 4 + r() * 2.5;
  const grp = new THREE.Group();
  const walls = [0xf4ead5, 0xe9d3b0, 0xdfe7ee, 0xf2d7c9][Math.floor(r() * 4)];
  const roofC = [0xb5452f, 0x7a4b33, 0x4a5f7a, 0x8f3b3b][Math.floor(r() * 4)];
  grp.add(mesh(new THREE.BoxGeometry(w, h, d), std(walls), 0, h / 2, 0));
  const roof = mesh(new THREE.CylinderGeometry(0.01, w * 0.72, d + 0.8, 4, 1).rotateX(Math.PI / 2).rotateZ(Math.PI / 4), std(roofC));
  roof.scale.set(1, 0.55, 1); roof.position.y = h + w * 0.28; roof.rotation.z = 0;
  grp.add(roof);
  grp.add(mesh(new THREE.BoxGeometry(0.9, 2.4, 0.9), std(0x8a8a8a), w * 0.25, h + 1.8, d * 0.2));
  for (const sx of [-1, 1]) grp.add(mesh(new THREE.BoxGeometry(0.1, 1.1, 1.3), std(0x5b9bd5, { emissive: 0x223344 }), sx * (w / 2 + 0.03), h * 0.55, 0, false));
  grp.position.set(x, y - 0.3, z); grp.rotation.y = rot;
  statics.add(grp);
  const ext = Math.max(w, d) / 2 * (Math.abs(Math.sin(rot * 2)) * 0.41 + 1);
  addObstacle([{ t: 'box', min: new V3(x - ext, y - 2, z - ext), max: new V3(x + ext, y + h + w * 0.4, z + ext) }]);
}

function addBirds(x, z, y, phase) {
  const grp = new THREE.Group();
  const birds = [];
  const wingG = new THREE.BoxGeometry(1.4, 0.06, 0.45); wingG.translate(0.7, 0, 0);
  for (let i = 0; i < 7; i++) {
    const b = new THREE.Group();
    b.add(mesh(new THREE.ConeGeometry(0.22, 1.0, 5).rotateX(Math.PI / 2), std(0x2b2b33)));
    const l = mesh(wingG, std(0x2b2b33)), r = mesh(wingG, std(0x2b2b33)); r.rotation.y = Math.PI;
    b.add(l, r); b.userData = { l, r, off: new V3((i % 3 - 1) * 3, (i % 2) * 1.5, -Math.floor(i / 2) * 2.2) };
    grp.add(b); birds.push(b);
  }
  world.add(grp);
  const cs = birds.map(() => new V3());
  addObstacle(cs.map((c) => ({ t: 'sph', c, r: 0.9 })), (t) => {
    const a = t * 0.45 + phase;
    const cx = x + Math.cos(a) * 18, cz = z + Math.sin(a) * 18, cy = y + Math.sin(t * 0.8 + phase) * 3;
    const heading = a + Math.PI;
    birds.forEach((b, i) => {
      const o = b.userData.off;
      const ox = o.x * Math.cos(heading) + o.z * Math.sin(heading), oz = -o.x * Math.sin(heading) + o.z * Math.cos(heading);
      b.position.set(cx + ox, cy + o.y, cz + oz);
      b.rotation.y = heading;
      const f = Math.sin(t * 9 + i) * 0.6;
      b.userData.l.rotation.z = f; b.userData.r.rotation.z = -f;
      cs[i].copy(b.position);
    });
  }, 22);
}

// --- Монеты и кольца ---
// Монета: рифлёный гурт по краю, выпуклый ободок и знак доллара на обеих сторонах
const COIN_R = 1.0, COIN_T = 0.3;
const COIN_GEO = (() => {
  const side = new THREE.CylinderGeometry(COIN_R, COIN_R, COIN_T, 72, 1, true);
  const p = side.attributes.position;
  for (let i = 0; i < p.count; i++) {                       // чередуем радиус — получаются рёбра гурта
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const k = Math.round((a + Math.PI) / (Math.PI * 2) * 72) % 2 ? 0.955 : 1;
    p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
  }
  side.computeVertexNormals();
  const parts = [side];
  for (const sy of [1, -1]) {
    const rim = new THREE.TorusGeometry(COIN_R - 0.07, 0.07, 6, 48).rotateX(Math.PI / 2);
    rim.translate(0, sy * COIN_T / 2, 0);
    const flat = new THREE.RingGeometry(COIN_R * 0.82, COIN_R - 0.07, 48, 1).rotateX(sy > 0 ? -Math.PI / 2 : Math.PI / 2);
    flat.translate(0, sy * (COIN_T / 2 - 0.005), 0);
    parts.push(rim, flat);
  }
  const gold = mergeGeometries(parts, false);
  const faces = [];
  for (const sy of [1, -1]) {
    const f = new THREE.CircleGeometry(COIN_R * 0.84, 48).rotateX(sy > 0 ? -Math.PI / 2 : Math.PI / 2);
    f.translate(0, sy * (COIN_T / 2 - 0.02), 0);
    faces.push(f);
  }
  return mergeGeometries([gold, mergeGeometries(faces, false)], true).rotateZ(Math.PI / 2);
})();
function coinFaceTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(48, 44, 6, 64, 64, 64);
  grd.addColorStop(0, '#ffe680'); grd.addColorStop(0.6, '#f5bd1f'); grd.addColorStop(1, '#d99a0b');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(150, 95, 0, .55)'; g.lineWidth = 3;
  g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.stroke();
  g.font = '900 78px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255, 245, 190, .9)'; g.fillText('$', 61, 63);    // блик — имитация чеканки
  g.fillStyle = '#a86a00'; g.fillText('$', 65, 67);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
let coinMesh;
function addCoin(x, y, z) { coins.push({ pos: new V3(x, y, z), from: new V3(), taken: false, anim: 1 }); }
function coinLine(x0, y0, z0, x1, y1, z1, n, arc = 0) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    addCoin(lerp(x0, x1, t), lerp(y0, y1, t) + arc * Math.sin(Math.PI * t), lerp(z0, z1, t));
  }
}
function buildCoins() {
  coinMesh = new THREE.InstancedMesh(COIN_GEO, [
    new THREE.MeshStandardMaterial({ color: 0xffc93c, metalness: 0.65, roughness: 0.3, emissive: 0x5a3c00, flatShading: true }),
    (() => { const t = coinFaceTexture(); return new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.35, metalness: 0.45, roughness: 0.35 }); })(),
  ], coins.length);
  coinMesh.castShadow = true;
  scene.add(coinMesh);
}
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new V3(), _yAxis = new V3(0, 1, 0);
const COIN_ANIM = 0.38;
const _cp = new V3();
function updateCoins(t, dt) {
  for (let i = 0; i < coins.length; i++) {
    const c = coins[i];
    if (!c.taken) {
      _q.setFromAxisAngle(_yAxis, t * 2.5 + i * 0.4);
      _m4.compose(c.pos, _q, _s.setScalar(1));
    } else if (c.anim < 1) {
      // Подбор: монета быстро крутится, подскакивает к самолёту, раздувается и исчезает
      c.anim = Math.min(1, c.anim + dt / COIN_ANIM);
      const k = c.anim;
      _cp.copy(c.from).lerp(P.pos, k * k).add(_vb.set(0, Math.sin(k * Math.PI) * 1.6, 0));
      _q.setFromAxisAngle(_yAxis, t * 2.5 + i * 0.4 + k * 14);
      const sc = k < 0.35 ? 1 + k / 0.35 * 0.45 : 1.45 * (1 - (k - 0.35) / 0.65);
      _m4.compose(_cp, _q, _s.setScalar(Math.max(0.0001, sc)));
    } else {
      _m4.compose(c.pos, _q, _s.setScalar(0.0001));
    }
    coinMesh.setMatrixAt(i, _m4);
  }
  coinMesh.instanceMatrix.needsUpdate = true;
}
function addRing(x, y, z) {
  const m = mesh(new THREE.TorusGeometry(6, 0.55, 8, 28), std(0x38d1ff, { emissive: 0x0b5f80, roughness: 0.4 }));
  m.position.set(x, y, z);
  world.add(m);
  // Кольцо без столкновений: сквозь него просто пролетают
  rings.push({ c: new V3(x, y, z), R: 6, tube: 0.55, mesh: m, taken: false, noseOk: null });
}

// --- Декор без столкновений ---
const CLOUD_MAT = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true, emissive: 0x8a96a3 });
const cloudRoot = new THREE.Group();
scene.add(cloudRoot);
function addCloud(x, y, z, s, seed) {
  const r = rng(seed);
  const grp = new THREE.Group();
  const mat = CLOUD_MAT;
  const n = 5 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const rr = (4 + r() * 6) * s;
    const p = new THREE.Mesh(new THREE.IcosahedronGeometry(rr, 1), mat);
    p.position.set((r() - 0.5) * 22 * s, (r() - 0.3) * 5 * s, (r() - 0.5) * 12 * s);
    p.scale.y = 0.7;
    grp.add(p);
  }
  grp.position.set(x, y, z);
  cloudRoot.add(grp);
  return grp;
}
function textSprite(text, color = '#fff', bg = 'rgba(20,30,45,0.85)', w = 256, h = 128, font = 64) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 18); g.fill();
  g.fillStyle = color; g.font = `800 ${font}px Segoe UI, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, w / 2, h / 2 + 4);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  return sp;
}

function buildDecor(R) {
  // Ангар позади старта
  const hangar = new THREE.Group();
  const roofG = new THREE.CylinderGeometry(9, 9, 22, 16, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
  hangar.add(mesh(roofG, std(0x9aa5ad, { metalness: 0.3 }), 0, 0, 0));
  hangar.add(mesh(new THREE.BoxGeometry(18, 7, 0.4), std(0x34495e), 0, 3.5, 11));
  hangar.add(mesh(new THREE.BoxGeometry(10, 6, 0.5), std(0x1d2733), 0, 3, 11.1, false));
  hangar.position.set(-26, terrainH(-26, -38), -38); hangar.rotation.y = 0.5;
  statics.add(hangar);
  // Ветроуказатель
  const pole = mesh(new THREE.CylinderGeometry(0.12, 0.15, 8, 6), std(0xdddddd), 14, 4, 6); statics.add(pole);
  const sock = mesh(new THREE.ConeGeometry(0.7, 3.2, 10, 1, true).rotateZ(Math.PI / 2), std(0xff7a1a, { side: THREE.DoubleSide }), 15.6, 7.6, 6); scene.add(sock);
  movers.push({ update: (t) => { sock.rotation.y = -0.4 + Math.sin(t * 0.7) * 0.25; sock.rotation.z = Math.sin(t * 1.9) * 0.06; } });
  // Забор вдоль старта
  for (let i = -6; i <= 6; i++) {
    for (const sx of [-1, 1]) {
      const x = sx * 18, z = i * 4 - 4;
      statics.add(mesh(new THREE.BoxGeometry(0.25, 1.4, 0.25), std(0x8b6a43), x, terrainH(x, z) + 0.7, z));
      if (i < 6) statics.add(mesh(new THREE.BoxGeometry(0.12, 0.18, 4), std(0x8b6a43), x, terrainH(x, z) + 1.0, z + 2, false));
    }
  }
  // Стога сена, валуны, деревья вдоль долины и на склонах
  for (let i = 0; i < 70; i++) {
    const z = 40 + R() * 3200, side = R() < 0.5 ? -1 : 1, x = side * (30 + R() * 65);
    if (Math.abs(z - RIVER_Z) < 40) continue;
    const y = terrainH(x, z);
    const hs = mesh(new THREE.CylinderGeometry(1.2, 1.2, 2, 10).rotateZ(Math.PI / 2), std(0xe2c15b), x, y + 1.1, z);
    hs.rotation.y = R() * 3; statics.add(hs);
  }
  for (let i = 0; i < 1900; i++) {
    const side = R() < 0.5 ? -1 : 1;
    const x = side * (VALLEY + 4 + Math.pow(R(), 1.3) * 200), z = -300 + R() * 3700;
    const h = terrainH(x, z);
    if (h > 95) continue;
    addDecorTree(x, z, 0.8 + R() * 0.8, R() < 0.7);
  }
  for (let i = 0; i < 40; i++) { const x = (R() - 0.5) * 60, z = -60 - R() * 200; addDecorTree(x + Math.sign(x) * 20, z, 0.8 + R() * 0.6, R() < 0.5); }
  // Трава и цветы
  const tuftG = new THREE.ConeGeometry(0.35, 1.1, 4); tuftG.translate(0, 0.45, 0);
  const tuftItems = [];
  for (let i = 0; i < 7000; i++) {
    const x = (R() - 0.5) * 2 * (VALLEY + 5), z = -40 + R() * 3300;
    const y = terrainH(x, z);
    const s = 0.7 + R() * 0.9, rot = R() * 6, k = R();
    if (y < WATER_Y + 0.3) continue;
    const c = new THREE.Color();
    if (k < 0.08) c.set(0xffe14d); else if (k < 0.13) c.set(0xffffff); else if (k < 0.17) c.set(0xe8506a); else if (k < 0.2) c.set(0xa07cf0);
    else c.setHSL(0.25 + R() * 0.08, 0.55, 0.3 + R() * 0.12);
    tuftItems.push({ m: new THREE.Matrix4().makeRotationY(rot).scale(new V3(s, s, s)).setPosition(x, y - 0.1, z), z, c });
  }
  const tufts = new THREE.Group(); tufts.name = 'tufts';
  chunkedInstances(tufts, tuftG, new THREE.MeshLambertMaterial({ flatShading: true }), tuftItems, false);
  scene.add(tufts);
  // Мост через реку
  // Деревянный мост: настил из досок по арке, въезды сливаются с дорогой, перила только над водой
  const bx = BRIDGE_X, bridge = new THREE.Group();
  const plankA = std(0x8b6a43), plankB = std(0x7a5b38), beam = std(0x5b3f22), stoneM = std(0x8a8580);
  for (let z = -BRIDGE_HALF_LEN; z < BRIDGE_HALF_LEN; z += 1) {
    const y0 = bridgeDeckY(RIVER_Z + z), y1 = bridgeDeckY(RIVER_Z + z + 1);
    const plank = mesh(new THREE.BoxGeometry(6.2, 0.3, Math.hypot(1, y1 - y0) + 0.02), (z & 1) ? plankA : plankB, 0, (y0 + y1) / 2 - 0.15, z + 0.5);
    plank.rotation.x = -Math.atan2(y1 - y0, 1);
    bridge.add(plank);
  }
  const railFrom = -30, railTo = 30, step = 4;
  for (const sx of [-1, 1]) {
    for (let z = railFrom; z <= railTo; z += step) {
      const y = bridgeDeckY(RIVER_Z + z);
      bridge.add(mesh(new THREE.BoxGeometry(0.22, 1.1, 0.22), beam, sx * 3.0, y + 0.55, z));
      if (z < railTo) {
        const y2 = bridgeDeckY(RIVER_Z + z + step);
        const rail = mesh(new THREE.BoxGeometry(0.14, 0.14, Math.hypot(step, y2 - y) + 0.1), plankA, sx * 3.0, (y + y2) / 2 + 1.05, z + step / 2);
        rail.rotation.x = -Math.atan2(y2 - y, step); bridge.add(rail);
      }
    }
  }
  const piers = [];
  for (const z of [-20, -10, 0, 10, 20]) {
    const top = bridgeDeckY(RIVER_Z + z) - 0.3;
    for (const sx of [-1, 1]) bridge.add(mesh(new THREE.CylinderGeometry(0.35, 0.45, top + 7, 7), beam, sx * 2.4, (top - 7) / 2, z));
    bridge.add(mesh(new THREE.BoxGeometry(5.6, 0.35, 0.4), beam, 0, top - 0.2, z));
    for (const sx of [-1, 1]) piers.push({ t: 'cyl', x: bx + sx * 2.4, z: RIVER_Z + z, r: 0.45, y0: -7, y1: top - 0.4 });
  }
  for (const sz of [-1, 1]) {                        // каменные устои там, где мост сходит на берег
    const z = sz * 30, y = bridgeDeckY(RIVER_Z + z);
    bridge.add(mesh(jitter(new THREE.BoxGeometry(7.2, 2.4, 3, 3, 1, 1), 0.25, 40 + sz), stoneM, 0, y - 1.5, z));
  }
  bridge.position.set(bx, 0, RIVER_Z);
  // Настил — это «земля», на него можно сесть; твёрдые только сваи под ним
  addObstacle(piers);
  statics.add(bridge);
  // Облака
  for (let i = 0; i < 80; i++) (addCloud((R() - 0.5) * 700, 70 + R() * 110, -200 + R() * 3600, 0.8 + R() * 1.2, i * 13 + 5));
  movers.push({ update: (t) => { cloudRoot.position.x = Math.sin(t * 0.01) * 40; } });
  // Таблички расстояний
  for (let d = 250; d < FINISH_Z; d += 250) {
    for (const sx of [-1, 1]) {
      const x = sx * 98, y = terrainH(x, d);
      statics.add(mesh(new THREE.CylinderGeometry(0.25, 0.25, 14, 6), std(0xeeeeee), x, y + 7, d));
      const sp = textSprite(`${d} м`); sp.scale.set(10, 5, 1); sp.position.set(x, y + 16, d); scene.add(sp);
    }
  }
  // Финиш
  const fy = terrainH(0, FINISH_Z);
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const cg = cv.getContext('2d');
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { cg.fillStyle = (i + j) % 2 ? '#111' : '#fff'; cg.fillRect(i * 8, j * 8, 8, 8); }
  const checker = new THREE.CanvasTexture(cv); checker.magFilter = THREE.NearestFilter; checker.wrapS = checker.wrapT = THREE.RepeatWrapping; checker.colorSpace = THREE.SRGBColorSpace;
  for (const sx of [-1, 1]) {
    const tex = checker.clone(); tex.repeat.set(1, 8); tex.needsUpdate = true;
    const tw = mesh(new THREE.BoxGeometry(4, 70, 4), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }), sx * 75, fy + 35, FINISH_Z);
    scene.add(tw);
    addObstacle([{ t: 'box', min: new V3(sx * 75 - 2, fy - 2, FINISH_Z - 2), max: new V3(sx * 75 + 2, fy + 70, FINISH_Z + 2) }]);
  }
  const bannerTex = (() => {
    const c2 = document.createElement('canvas'); c2.width = 1024; c2.height = 128; const g = c2.getContext('2d');
    for (let i = 0; i < 64; i++) for (let j = 0; j < 8; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * 16, j * 16, 16, 16); }
    g.fillStyle = 'rgba(220,40,40,0.92)'; g.fillRect(300, 10, 424, 108);
    g.fillStyle = '#fff'; g.font = '800 84px Segoe UI, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('ФИНИШ', 512, 68);
    const t = new THREE.CanvasTexture(c2); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(146, 14), new THREE.MeshStandardMaterial({ map: bannerTex, side: THREE.DoubleSide, roughness: 0.8 }));
  banner.position.set(0, fy + 62, FINISH_Z);
  banner.rotation.y = Math.PI;
  scene.add(banner);
  const lineTex = checker.clone(); lineTex.repeat.set(30, 1); lineTex.needsUpdate = true;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(150, 6), new THREE.MeshStandardMaterial({ map: lineTex, polygonOffset: true, polygonOffsetFactor: -3 }));
  line.rotation.x = -Math.PI / 2; line.position.set(0, fy + 0.3, FINISH_Z); line.receiveShadow = true;
  scene.add(line);
  for (let i = 0; i < 12; i++) {
    const f = mesh(new THREE.BoxGeometry(0.15, 1.6, 2.4), std([0xe74c3c, 0xf1c40f, 0x3498db, 0x2ecc71][i % 4]), -66 + i * 12, fy + 54, FINISH_Z, false);
    scene.add(f);
    movers.push({ update: (t) => { f.rotation.x = Math.sin(t * 3 + i) * 0.3; } });
  }
}

function generateWorld() {
  const R = rng(20261020);
  const rx = (m = 0) => (R() * 2 - 1) * (VALLEY - m);
  const nearRiver = (z, d = 30) => Math.abs(z - RIVER_Z) < d;
  const freeOfRoad = (x, z, d = 6) => Math.abs(x - roadX(z)) > d;

  // Деревни по краям
  for (const [zc, side, n] of [[30, 1, 3], [60, -1, 2], [380, -1, 4], [640, 1, 3], [1230, -1, 3], [1900, 1, 3], [2560, -1, 4]]) {
    for (let i = 0; i < n; i++) addHouse(side * (48 + R() * 42), zc + i * 16 + R() * 6, R() * 0.6 - 0.3 + (R() < 0.5 ? 0 : Math.PI / 2), Math.floor(R() * 1e6));
  }

  // Зона 1 (140–480): редкие деревья и валуны
  for (let z = 140; z < 480; z += 9 + R() * 12) {
    const x = rx(4); if (!freeOfRoad(x, z)) continue;
    const n = 1 + Math.floor(R() * 3);
    for (let k = 0; k < n; k++) addTree(x + (R() - 0.5) * 12, z + (R() - 0.5) * 10, 0.9 + R() * 0.6, R() < 0.55);
  }
  for (let i = 0; i < 6; i++) addRock(rx(8), 160 + R() * 320, 2 + R() * 2.5, i + 11);
  addPillar(-30, 420, 5, 26, 3);
  addPillar(45, 465, 4, 32, 4);
  coinLine(0, 14, 160, 0, 14, 220, 6, 8);
  coinLine(-30, 38, 400, -30, 38, 440, 4, 4);
  coinLine(20, 10, 300, 40, 10, 360, 5, 6);
  addRing(0, 22, 340);
  addRing(-15, 30, 470);

  // Зона 2 (480–1000): столбы-скалы, ветряки, воздушные шары, река
  for (let z = 480; z < 1000; z += 10 + R() * 12) {
    if (nearRiver(z)) continue;
    const x = rx(4); if (!freeOfRoad(x, z)) continue;
    const n = 1 + Math.floor(R() * 4);
    for (let k = 0; k < n; k++) addTree(x + (R() - 0.5) * 14, z + (R() - 0.5) * 12, 0.9 + R() * 0.8, R() < 0.6);
  }
  for (const [x, z, r, H] of [[10, 540, 5, 30], [-55, 600, 6, 42], [70, 660, 4.5, 36], [-10, 700, 5.5, 46], [35, 860, 6, 40], [-70, 900, 5, 34], [0, 960, 4, 50]]) addPillar(x, z, r, H, z);
  addTurbine(-35, 620, 38, 0.8, 1);
  addTurbine(50, 820, 40, -0.7, 2);
  addTurbine(-20, 980, 42, 0.9, 0.3);
  addBalloon(-40, 560, 30, 0, 0);
  addBalloon(25, 720, 38, 1.5, 1);
  addBalloon(-60, 800, 26, 3, 2);
  addBalloon(60, 940, 44, 2.2, 3);
  coinLine(-10, 22, 740, -10, 22, 790, 6, 3);
  coinLine(10, 60, 700, 10, 60, 720, 3);
  coinLine(40, 18, 600, 40, 30, 660, 5);
  coinLine(-35, 30, 860, -35, 55, 900, 4);
  addRing(-10, 26, 765);
  addRing(30, 18, 905);

  // Зона 3 (1000–1700): поля ветряков, ЛЭП, шары, птицы
  for (let z = 1000; z < 1700; z += 12 + R() * 14) {
    const x = rx(4); if (!freeOfRoad(x, z)) continue;
    const n = 1 + Math.floor(R() * 3);
    for (let k = 0; k < n; k++) addTree(x + (R() - 0.5) * 12, z + (R() - 0.5) * 10, 0.9 + R() * 0.7, R() < 0.5);
  }
  for (const x of [-78, -26, 26, 78]) addTurbine(x, 1100, 40, x > 0 ? 0.75 : -0.75, x * 0.1);
  addPowerLine(1250);
  for (const x of [-52, 0, 52]) addTurbine(x, 1420, 44, 0.85, x * 0.07);
  addPowerLine(1620);
  for (const [x, z, r, H] of [[-30, 1180, 5, 38], [60, 1320, 6, 48], [-75, 1350, 5, 30], [15, 1530, 6, 55], [-40, 1680, 5, 44]]) addPillar(x, z, r, H, z);
  addBalloon(5, 1050, 32, 0.5, 4);
  addBalloon(-45, 1200, 40, 2, 0);
  addBalloon(40, 1340, 26, 4, 1);
  addBalloon(-15, 1500, 46, 1, 2);
  addBalloon(70, 1560, 34, 3.4, 3);
  addBalloon(-70, 1460, 30, 5, 4);
  addBirds(20, 1170, 30, 0);
  addBirds(-30, 1580, 42, 2);
  coinLine(0, 30, 1080, 0, 30, 1120, 5);
  coinLine(-52, 16, 1230, -52, 16, 1270, 5, -4);
  coinLine(26, 44, 1240, 26, 44, 1260, 3);
  coinLine(26, 22, 1400, 26, 22, 1440, 5);
  coinLine(-20, 16, 1600, -20, 16, 1640, 5, -3);
  addRing(-26, 26, 1100);
  addRing(52, 30, 1300);
  addRing(0, 18, 1620);

  // Зона 4 (1700–2450): скальные стены с проёмами, парящие скалы, дирижабли
  addWall(1800, [{ x: -40, w: 34, y0: 8, y1: 40 }, { x: 55, w: 30, y0: 28, y1: 58 }], 31);
  for (let z = 1820; z < 2380; z += 14 + R() * 14) {
    const x = rx(6); if (!freeOfRoad(x, z)) continue;
    for (let k = 0; k < 2; k++) addTree(x + (R() - 0.5) * 12, z + (R() - 0.5) * 10, 1 + R() * 0.7, true);
  }
  for (let i = 0; i < 14; i++) { const z = 1870 + i * 34 + R() * 15; addFloatingRock(rx(15), z, 22 + R() * 45, 5 + R() * 6, i * 7 + 3); }
  addBlimp(0, 1960, 40, 45, 0);
  addBlimp(0, 2140, 30, 55, 2);
  addBlimp(0, 2290, 52, 40, 4);
  addWall(2400, [{ x: 10, w: 30, y0: 14, y1: 44 }, { x: -70, w: 26, y0: 40, y1: 66 }, { x: 80, w: 24, y0: 6, y1: 30 }], 57);
  coinLine(-40, 24, 1780, -40, 24, 1830, 6);
  coinLine(55, 43, 1790, 55, 43, 1810, 3);
  coinLine(-20, 30, 2030, 20, 30, 2080, 6, 6);
  coinLine(10, 29, 2380, 10, 29, 2420, 5);
  addRing(-40, 24, 1860);
  addRing(0, 40, 2200);

  // Зона 5 (2450–2990): финальная полоса — всё вместе
  for (let z = 2450; z < 2980; z += 11 + R() * 12) {
    const x = rx(4); if (!freeOfRoad(x, z)) continue;
    const n = 1 + Math.floor(R() * 3);
    for (let k = 0; k < n; k++) addTree(x + (R() - 0.5) * 12, z + (R() - 0.5) * 10, 0.9 + R() * 0.8, R() < 0.6);
  }
  for (const [x, z] of [[-60, 2520], [30, 2560], [-10, 2640], [70, 2780], [-45, 2840], [15, 2920]]) addTurbine(x, z, 38 + R() * 8, R() < 0.5 ? 0.9 : -0.9, R() * 6);
  addPowerLine(2720);
  for (const [x, z, r, H] of [[50, 2480, 6, 44], [-80, 2600, 5, 36], [-30, 2760, 6, 50], [45, 2880, 5, 40]]) addPillar(x, z, r, H, z);
  addBalloon(-25, 2500, 36, 0, 0);
  addBalloon(55, 2620, 28, 1, 1);
  addBalloon(-60, 2700, 44, 2, 2);
  addBalloon(20, 2820, 32, 3, 3);
  addBalloon(-15, 2950, 40, 4.4, 4);
  addBirds(0, 2600, 26, 1);
  addBirds(40, 2900, 34, 3);
  coinLine(-10, 20, 2700, -10, 20, 2740, 5, -3);
  coinLine(0, 30, 2960, 0, 30, 2995, 6);
  addRing(-10, 18, 2720);
  addRing(0, 34, 2990);

  buildDecor(R);
  buildTrees();
  buildCoins();
  obstacles.sort((a, b) => a.zMin - b.zMin);
}

// Склеиваем неподвижные меши в несколько больших по материалу и участку трассы —
// так вместо тысяч вызовов отрисовки остаются десятки.
function mergeStatic(root, chunk = 300) {
  root.updateMatrixWorld(true);
  const buckets = new Map(), done = [];
  const wp = new V3(), rootInv = root.matrixWorld.clone().invert(), rel = new THREE.Matrix4();
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || Array.isArray(o.material) || o.material.map) return;
    o.getWorldPosition(wp);
    const key = `${o.material.uuid}|${o.castShadow}|${chunk ? Math.floor(wp.z / chunk) : 0}`;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    g.applyMatrix4(rel.multiplyMatrices(rootInv, o.matrixWorld));
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && !(name === 'color' && o.material.vertexColors)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.clearGroups();
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, cast: o.castShadow, geos: [] });
    buckets.get(key).geos.push(g);
    done.push(o);
  });
  for (const o of done) o.parent.remove(o);
  for (const b of buckets.values()) {
    const merged = mergeGeometries(b.geos, false);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, b.mat);
    m.castShadow = b.cast; m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    root.add(m);
    b.geos.forEach((g) => g.dispose());
  }
}

// =====================================================================
//  Рогатка
// =====================================================================

const SL = { tips: [new V3(-2.6, 4.6, 1.8), new V3(2.6, 4.6, 1.8)], rest: new V3(0, 3.6, 0) };
const bandMat = new THREE.MeshStandardMaterial({ color: 0x3b2a20, roughness: 0.8 });
const bandGeo = new THREE.CylinderGeometry(0.11, 0.11, 1, 6);
const bands = [new THREE.Mesh(bandGeo, bandMat), new THREE.Mesh(bandGeo, bandMat)];
const pouch = mesh(new THREE.BoxGeometry(1.2, 0.9, 0.4), std(0x5a3a26));
let bandK = 1, slingGroup = null, slingAnim = null;

// Ступени рогатки: 0 — ветка, 1..5 — эпохи по 5 уровней, 6 — легендарная (25 ур.)
const glow = (c, k = 0.9) => ({ emissive: c, emissiveIntensity: k });
const SLING_STYLES = [
  { wood: [0x8a5a2b], bind: [0x6b4a2b], band: [0x5a3a26], bandR: 0.09, base: 'mound' },
  { wood: [0x9b6a35], bind: [0xcaa56b], band: [0x3b2a20], bandR: 0.11, base: 'stone' },
  { wood: [0x6e4220], bind: [0x5d646c, { metalness: 0.36, roughness: 0.4 }], band: [0x8b1e1e], bandR: 0.13, base: 'steps' },
  { wood: [0xc3ccd6, { metalness: 0.36, roughness: 0.35 }], bind: [0x3d434a, { metalness: 0.36, roughness: 0.4 }], band: [0x1c1c1c], bandR: 0.15, base: 'steel' },
  { wood: [0x5a2f14], bind: [0xd4a017, { metalness: 0.36, roughness: 0.25 }], band: [0xb3122e], bandR: 0.16, base: 'marble' },
  { wood: [0xbfe3f5, { metalness: 0.36, roughness: 0.25 }], bind: [0x4fd2ff, glow(0x1a8fd0)], band: [0x2fd0ff, glow(0x0f8fd0)], bandR: 0.17, base: 'rune' },
  { wood: [0x2a1846, { metalness: 0.36, roughness: 0.3 }], bind: [0xff6bff, glow(0xc030c0)], band: [0xff4fd8, glow(0xc02090, 1.2)], bandR: 0.19, base: 'rune' },
];
const matOf = (spec) => std(spec[0], spec[1] || {});
const orient = (m, dir) => { m.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir.clone().normalize()); return m; };
function buildSlingshot() {
  if (slingGroup) scene.remove(slingGroup);
  slingAnimParts.length = 0;
  const lv = save.lv.sling;
  const ti = lv === 0 ? 0 : lv >= 25 ? 6 : tierOf(lv) + 1;
  const sub = lv === 0 ? 1 : lv >= 25 ? 5 : subOf(lv);
  const st = SLING_STYLES[ti];
  const k = 1 + lv * 0.016;                         // с каждым уровнем рогатка подрастает
  const g = new THREE.Group();
  g.position.set(0, terrainH(0, 0), 0);
  const mWood = matOf(st.wood), mBind = matOf(st.bind), Z = 1.8;
  const armR = (0.3 + ti * 0.04) * k;

  // Основание
  const stone = std(0x8c8c8c), dark = std(0x5c5f63);
  if (st.base === 'mound') g.add(mesh(new THREE.ConeGeometry(2.2, 0.7, 9), std(0x6b5030), 0, 0.2, Z));
  if (st.base === 'stone') g.add(mesh(jitter(new THREE.CylinderGeometry(3.3, 3.8, 0.6, 10), 0.25, 7), std(0x7c7c7c), 0, 0.2, Z));
  if (st.base === 'steps') {
    g.add(mesh(new THREE.CylinderGeometry(3.6, 4.0, 0.5, 12), stone, 0, 0.15, Z));
    g.add(mesh(new THREE.CylinderGeometry(2.8, 3.1, 0.45, 12), dark, 0, 0.6, Z));
    for (let i = 0; i < 6 + sub * 2; i++) { const a = i / (6 + sub * 2) * Math.PI * 2; g.add(mesh(new THREE.SphereGeometry(0.13, 6, 4), mBind, Math.cos(a) * 2.95, 0.85, Z + Math.sin(a) * 2.95)); }
  }
  if (st.base === 'steel') {
    g.add(mesh(new THREE.CylinderGeometry(3.7, 4.1, 0.8, 8), std(0x6c757d, { metalness: 0.36, roughness: 0.4 }), 0, 0.25, Z));
    for (let i = 0; i < 8 + sub * 2; i++) { const a = i / (8 + sub * 2) * Math.PI * 2; g.add(mesh(new THREE.SphereGeometry(0.12, 6, 4), mBind, Math.cos(a) * 3.55, 0.68, Z + Math.sin(a) * 3.55)); }
    // шестерня натяжного механизма
    const gear = new THREE.Group();
    gear.add(mesh(new THREE.TorusGeometry(0.9, 0.18, 6, 16), mBind));
    for (let i = 0; i < 10; i++) { const t = mesh(new THREE.BoxGeometry(0.28, 0.35, 0.3), mBind); const a = i / 10 * Math.PI * 2; t.position.set(Math.cos(a) * 1.1, Math.sin(a) * 1.1, 0); t.rotation.z = a; gear.add(t); }
    gear.position.set(1.6, 1.2, Z + 0.9); g.add(gear);
    slingAnimParts.push({ obj: gear, spin: 0.6 });
  }
  if (st.base === 'marble') {
    g.add(mesh(new THREE.CylinderGeometry(3.8, 4.2, 0.5, 16), std(0xeeeae0, { roughness: 0.35 }), 0, 0.15, Z));
    g.add(mesh(new THREE.CylinderGeometry(3.0, 3.3, 0.45, 16), std(0xf6f2e8, { roughness: 0.35 }), 0, 0.6, Z));
    for (const [r, y] of [[4.0, 0.42], [3.15, 0.84]]) g.add(mesh(new THREE.TorusGeometry(r, 0.07, 6, 40).rotateX(Math.PI / 2), mBind, 0, y, Z));
  }
  if (st.base === 'rune') {
    g.add(mesh(new THREE.CylinderGeometry(3.8, 4.3, 0.7, 10), std(0x2c3340, { roughness: 0.6 }), 0, 0.2, Z));
    g.add(mesh(new THREE.TorusGeometry(3.3, 0.09, 6, 48).rotateX(Math.PI / 2), mBind, 0, 0.58, Z));
    for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; const r = mesh(new THREE.BoxGeometry(0.35, 0.06, 0.18), mBind, Math.cos(a) * 3.7, 0.56, Z + Math.sin(a) * 3.7); r.rotation.y = -a; g.add(r); }
  }

  // Ствол и рога
  const stemH = 2.6 * k;
  g.add(mesh(new THREE.CylinderGeometry(armR * 1.3, armR * 1.75, stemH, 8), mWood, 0, stemH / 2, Z));
  const tips = [];
  for (const sx of [-1, 1]) {
    const a = new V3(0, 2.5 * k, Z), b = new V3(sx * 2.6 * k, 4.6 * k, Z);
    const d = b.clone().sub(a);
    const arm = orient(mesh(new THREE.CylinderGeometry(armR, armR * 1.2, d.length(), 8), mWood), d);
    arm.position.copy(a).addScaledVector(d, 0.5); g.add(arm);
    g.add(mesh(new THREE.SphereGeometry(armR * 1.2, 10, 8), mBind, b.x, b.y, b.z));
    // обмотки/оковка: на каждом уровне ступени — на одну больше
    for (let i = 0; i < sub; i++) {
      const ring = mesh(new THREE.TorusGeometry(armR * 1.12, 0.07 * k, 6, 14), mBind);
      ring.position.copy(a).lerp(b, 0.2 + i * 0.14);
      ring.quaternion.setFromUnitVectors(new V3(0, 0, 1), d.clone().normalize());
      g.add(ring);
    }
    if (sub >= 3 || ti >= 4) {               // шипы на рогах
      for (let i = 0; i < (ti >= 4 ? 3 : 1); i++) {
        const sp = mesh(new THREE.ConeGeometry(armR * 0.45, armR * 2.2, 6), mBind);
        const dir = new V3(sx * (0.4 + i * 0.3), 1, (i - 1) * 0.5);
        orient(sp, dir); sp.position.copy(b).addScaledVector(dir.normalize(), armR * 1.6); g.add(sp);
      }
    }
    if (sub >= 5 || ti >= 5) {               // флажки на рогах
      const pole = mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5), std(0x3a3a3a), b.x, b.y + 1.4, b.z); g.add(pole);
      const flag = mesh(new THREE.BoxGeometry(0.05, 0.7, 1.1), matOf(st.band), b.x, b.y + 2.1, b.z - 0.55, false); g.add(flag);
      slingAnimParts.push({ obj: flag, wave: sx });
    }
    if (ti >= 5) {                            // светящиеся сферы над рогами
      const orb = mesh(new THREE.IcosahedronGeometry(0.32 * k, 1), mBind, b.x, b.y + 0.9, b.z, false); g.add(orb);
      slingAnimParts.push({ obj: orb, bob: b.y + 0.9 });
    }
    tips.push(new V3(b.x, b.y, b.z));
  }
  if (sub >= 2) for (let i = 0; i < sub * 2; i++) {      // заклёпки на стволе
    const a = i / (sub * 2) * Math.PI * 2;
    g.add(mesh(new THREE.SphereGeometry(0.09 * k, 6, 4), mBind, Math.cos(a) * armR * 1.45, stemH * 0.55, Z + Math.sin(a) * armR * 1.45));
  }
  if (sub >= 4 || ti >= 4) {                              // герб на стволе
    const sh = mesh(new THREE.CylinderGeometry(0.45 * k, 0.45 * k, 0.1, 6).rotateX(Math.PI / 2), mBind, 0, stemH * 0.6, Z - armR * 1.6);
    g.add(sh);
    g.add(mesh(new THREE.OctahedronGeometry(0.18 * k), matOf(st.band), 0, stemH * 0.6, Z - armR * 1.6 - 0.1));
  }
  if (ti >= 4) {                                          // корона в развилке
    const crown = new THREE.Group();
    crown.add(mesh(new THREE.TorusGeometry(0.55 * k, 0.09, 6, 16).rotateX(Math.PI / 2), mBind));
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; crown.add(mesh(new THREE.ConeGeometry(0.12, 0.45, 5), mBind, Math.cos(a) * 0.55 * k, 0.25, Math.sin(a) * 0.55 * k)); }
    for (let i = 0; i < sub; i++) { const a = i / sub * Math.PI * 2 + 0.5; crown.add(mesh(new THREE.OctahedronGeometry(0.11), std(0xe0115f, glow(0x800830, 0.6)), Math.cos(a) * 0.62 * k, 0.05, Math.sin(a) * 0.62 * k)); }
    crown.position.set(0, 2.55 * k, Z); g.add(crown);
  }
  if (ti === 6) {                                         // легенда: кристаллы на орбите
    for (let i = 0; i < 3; i++) {
      const c = mesh(new THREE.OctahedronGeometry(0.45, 0), std(0xff9bff, glow(0xc040c0, 1.1)), 0, 0, 0, false);
      g.add(c); slingAnimParts.push({ obj: c, orbit: i * Math.PI * 2 / 3, cy: 3.4 * k, cz: Z });
    }
  }
  scene.add(g);
  slingGroup = g;
  SL.tips = tips;
  SL.rest.y = 3.6 + (k - 1) * 3.2;
  bandMat.color.set(st.band[0]);
  bandMat.emissive.set(st.band[1]?.emissive ?? 0x000000);
  bandMat.emissiveIntensity = st.band[1]?.emissiveIntensity ?? 1;
  bandK = st.bandR / 0.11;
  for (const b of bands) { b.castShadow = true; if (!b.parent) scene.add(b); }
  if (!pouch.parent) scene.add(pouch);
  pouch.material = matOf(ti >= 4 ? st.bind : [0x5a3a26]);
}
const slingAnimParts = [];
function animateSlingshot(t) {
  for (const p of slingAnimParts) {
    if (p.spin) p.obj.rotation.z = t * p.spin;
    if (p.wave) p.obj.rotation.y = Math.sin(t * 3 + p.wave) * 0.25;
    if (p.bob) { p.obj.position.y = p.bob + Math.sin(t * 2) * 0.15; p.obj.rotation.y = t; }
    if (p.orbit !== undefined) { const a = t * 0.8 + p.orbit; p.obj.position.set(Math.cos(a) * 1.6, p.cy + Math.sin(t * 1.7 + p.orbit) * 0.3, p.cz + Math.sin(a) * 1.6); p.obj.rotation.set(t, t * 1.3, 0); }
  }
}
function setBand(m, a, b) {
  const d = b.clone().sub(a);
  m.scale.set(bandK, d.length(), bandK);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(_yAxis, d.normalize());
}

// =====================================================================
//  Модель самолёта
// =====================================================================

let plane = null;
// Зеркалим геометрию по X с правильным порядком вершин (иначе грани вывернутся)
function mirrorX(geo) {
  geo.scale(-1, 1, 1);
  const idx = geo.index;
  if (idx) for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i); idx.setX(i, idx.getX(i + 2)); idx.setX(i + 2, a); }
  geo.computeVertexNormals();
  return geo;
}
// Половина крыла от корня (x=0) до законцовки (x=span): сужение и стреловидность
function wingGeo(span, chord, taper, sweep, thick, sx) {
  const g = new THREE.BoxGeometry(span, thick, chord, 6, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + span / 2, k = x / span;
    p.setX(i, x); p.setZ(i, p.getZ(i) * (1 - (1 - taper) * k) - sweep * k);
    p.setY(i, p.getY(i) * (1 - 0.4 * k));
  }
  g.computeVertexNormals();
  return sx < 0 ? mirrorX(g) : g;
}
const PAINTS = [0xb08a5a, 0xc0392b, 0xd35400, 0xe67e22, 0xf1c40f, 0x27ae60, 0x16a085, 0x2980b9, 0x2e86de, 0x8e44ad, 0x34495e, 0xe74c3c, 0x1abc9c, 0x2c3e50, 0xf5f6f8, 0xdfe6ee];
const ACCENTS = [0x7f8c8d, 0xf5f6f8, 0xf5f6f8, 0x2c3e50, 0x2c3e50, 0xf1c40f, 0xf5f6f8, 0xf1c40f, 0xf5f6f8, 0xf1c40f, 0xe67e22, 0x2c3e50, 0x2c3e50, 0xe74c3c, 0xe74c3c, 0xd4a017];
const NAV_L = () => std(0xff3030, glow(0xff2020, 1.2)), NAV_R = () => std(0x30ff60, glow(0x20ff40, 1.2));

function buildPlaneMesh(L) {
  const g = new THREE.Group();
  const spinners = [], flames = [], blurs = [];
  const aero = L.aero, at = aero === 0 ? -1 : aero >= 15 ? 3 : tierOf(aero), asub = subOf(aero);
  const chrome = aero >= 15;
  const paint = PAINTS[aero], accent = ACCENTS[aero];
  const mP = chrome ? std(0xf4f8fc, { metalness: 0.36, roughness: 0.15 }) : std(paint, { roughness: 0.55 });
  const mA = chrome ? std(0xd4a017, { metalness: 0.36, roughness: 0.2 }) : std(accent, { roughness: 0.5 });
  const mDark = std(0x2b2b2b), mMetal = std(0x9aa3ad, { metalness: 0.36, roughness: 0.35 });
  const mGlass = new THREE.MeshStandardMaterial({ color: 0x9fd3ff, metalness: 0.24, roughness: 0.15, transparent: true, opacity: 0.85 });

  // --- Фюзеляж (обтекаемость) ---
  let bodyR = 0.45;
  if (at === -1) {
    g.add(mesh(new THREE.BoxGeometry(0.9, 0.9, 4), std(0xb08a5a)));
    g.add(mesh(new THREE.BoxGeometry(0.92, 0.1, 4.02), std(0x8c6a40), 0, 0.2, 0));
  } else if (at === 0) {
    g.add(mesh(new THREE.BoxGeometry(0.85, 0.85, 3.5), mP, 0, 0, -0.2));
    g.add(mesh(new THREE.CylinderGeometry(0.2, 0.6, 0.9, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4), mP, 0, 0, 1.95));
    for (let i = 0; i < asub - 1; i++) g.add(mesh(new THREE.BoxGeometry(0.08, 0.02, 3.4), mA, (i - (asub - 2) / 2) * 0.16, 0.43, -0.2, false));
  } else {
    bodyR = at === 1 ? 0.47 : 0.42;
    const r0 = bodyR, pts = [new THREE.Vector2(0, -2.2)];
    for (let i = 0; i <= 12; i++) { const t = i / 12; const z = -2.2 + t * 4.4; const r = t < 0.15 ? lerp(0.16, r0 * 0.9, t / 0.15) : t > 0.85 ? r0 * (1 - (t - 0.85) / 0.15 * 0.55) : r0 * (0.9 + 0.1 * Math.sin((t - 0.15) / 0.7 * Math.PI)); pts.push(new THREE.Vector2(r, z)); }
    pts.push(new THREE.Vector2(0, 2.2));
    g.add(mesh(new THREE.LatheGeometry(pts, 16).rotateX(Math.PI / 2), chrome ? std(0xf4f8fc, { metalness: 0.36, roughness: 0.15, side: THREE.DoubleSide }) : std(paint, { roughness: 0.55, side: THREE.DoubleSide })));
    const n = at === 3 ? 3 : asub;                        // гоночные полосы сверху
    for (let i = 0; i < n; i++) g.add(mesh(new THREE.BoxGeometry(0.07, 0.03, 3.4), mA, (i - (n - 1) / 2) * 0.12, r0 * 0.98, 0, false));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(0.04, 0.12, 3.4), mA, sx * r0 * 0.99, 0, 0, false));
    if (asub >= 3 || at >= 2) g.add(mesh(new THREE.ConeGeometry(0.2, 0.5, 10).rotateX(-Math.PI / 2), mA, 0, 0, -2.35));
    if (asub >= 5 || at >= 2) for (const sx of [-1, 1]) {   // опознавательные круги
      g.add(mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 16).rotateZ(Math.PI / 2), std(0xf5f6f8), sx * r0 * 0.97, 0.02, -0.9, false));
      g.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.03, 16).rotateZ(Math.PI / 2), mA, sx * r0 * 0.98, 0.02, -0.9, false));
    }
    if (at >= 2) g.add(mesh(new THREE.BoxGeometry(0.16, 0.18, 1.6), mP, 0, r0 * 0.95, -1.1));   // гаргрот за кабиной
  }
  const cock = mesh(new THREE.SphereGeometry(0.4, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mGlass, 0, bodyR * 0.8, 0.35);
  cock.scale.set(1, 0.9, at >= 2 ? 2.1 : 1.7);
  g.add(cock);
  if (at >= 1) g.add(mesh(new THREE.TorusGeometry(0.4, 0.035, 5, 16, Math.PI).rotateY(Math.PI / 2), mA, 0, bodyR * 0.8, 0.35, false));

  // --- Крылья ---
  const W = L.wings, wt = W === 0 ? -1 : W >= 25 ? 5 : tierOf(W), wsub = W >= 25 ? 5 : subOf(W);
  const span = wingSpan(W), half = span / 2;
  const wingAt = new V3(0, -0.2, 0.35);
  // базовая плоскость крыла: материал, сужение, стреловидность
  const WS = [
    { mat: std(0xd9bd8c), chord: 1.35, taper: 1, sweep: 0, thick: 0.12, dih: 0.05 },
    { mat: std(0xa8743e), chord: 1.2, taper: 1, sweep: 0, thick: 0.1, dih: 0.03 },
    { mat: std(0xc9d1d9, { metalness: 0.36, roughness: 0.35 }), chord: 1.3, taper: 0.7, sweep: 0.15, thick: 0.12, dih: 0.06 },
    { mat: std(0xf5f6f8, { roughness: 0.35 }), chord: 1.3, taper: 0.6, sweep: 0.3, thick: 0.13, dih: 0.07 },
    { mat: std(0x1d1f24, { metalness: 0.32, roughness: 0.4 }), chord: 1.35, taper: 0.5, sweep: 0.5, thick: 0.13, dih: 0.06 },
    { mat: std(0xff7a1a, glow(0x802000, 0.6)), chord: 1.35, taper: 0.55, sweep: 0.45, thick: 0.13, dih: 0.08 },
  ][Math.max(0, wt)];
  const chordAt = (k) => WS.chord * (1 - (1 - WS.taper) * k), zAt = (k) => -WS.sweep * k;
  if (W > 0) {
    for (const sx of [-1, 1]) {
      const hw = new THREE.Group();
      hw.position.copy(wingAt); hw.rotation.z = sx * WS.dih;
      const X = (k) => sx * k * half;
      hw.add(mesh(wingGeo(half, WS.chord, WS.taper, WS.sweep, WS.thick, sx), WS.mat));
      if (wt === 0) {                                     // фанера: окрашенные полосы
        for (let i = 0; i < wsub - 1; i++) { const k = 0.3 + i * 0.15; hw.add(mesh(new THREE.BoxGeometry(0.14, WS.thick + 0.01, chordAt(k) + 0.01), std(0xc0392b), X(k), 0, zAt(k), false)); }
        hw.add(mesh(new THREE.BoxGeometry(0.06, 0.62, 0.06), mDark, X(0.32), 0.3, 0));
      }
      if (wt === 1) {                                     // биплан: верхнее крыло и стойки
        const up = mesh(wingGeo(half * 1.05, WS.chord, 1, 0, WS.thick, sx), WS.mat, 0, 0.95, 0.15); hw.add(up);
        const struts = wsub >= 3 ? [0.35, 0.75] : [0.6];
        for (const k of struts) for (const dz of [-0.35, 0.35]) hw.add(mesh(new THREE.BoxGeometry(0.06, 0.95, 0.06), mDark, X(k), 0.47, dz + 0.07));
        hw.add(mesh(new THREE.BoxGeometry(0.22, WS.thick + 0.02, WS.chord + 0.02), std(0xc0392b), X(1) - sx * 0.1, 0, 0, false));
        hw.add(mesh(new THREE.BoxGeometry(0.22, WS.thick + 0.02, WS.chord + 0.02), std(0xc0392b), X(1.05) - sx * 0.1, 0.95, 0.15, false));
        if (wsub >= 4) { const wire = orient(mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.4, 4), mDark), new V3(sx * half * 0.4, 0.95, 0)); wire.position.set(X(0.55), 0.47, 0.07); hw.add(wire); }
        if (wsub >= 5) for (let i = 0; i < 3; i++) hw.add(mesh(new THREE.BoxGeometry(0.1, WS.thick + 0.02, WS.chord + 0.02), std(0xf1c40f), X(0.4 + i * 0.12), 0.95, 0.15, false));
      }
      if (wt >= 2 && wt <= 4) {                           // элерон
        hw.add(mesh(new THREE.BoxGeometry(half * 0.32, WS.thick + 0.02, 0.25), mA, X(0.72), 0, zAt(0.72) - chordAt(0.72) / 2 + 0.12, false));
      }
      if (wt === 2) {                                     // дюраль: линии заклёпок
        for (let i = 0; i < wsub; i++) { const zf = -0.35 + i * 0.17; hw.add(mesh(new THREE.BoxGeometry(half * 0.9, WS.thick + 0.012, 0.02), mDark, X(0.5), 0, zAt(0.5) + zf * chordAt(0.5), false)); }
        if (wsub >= 5) hw.add(mesh(new THREE.CapsuleGeometry(0.16, 0.9, 4, 8).rotateX(Math.PI / 2), mA, X(1), 0, zAt(1)));
      }
      if (wt === 3) {                                     // композит: полоса и растущие винглеты
        hw.add(mesh(new THREE.BoxGeometry(half * 0.95, WS.thick + 0.01, 0.12), mA, X(0.5), 0, zAt(0.5) + chordAt(0.5) * 0.15, false));
        const wh = 0.25 + wsub * 0.08;
        const wl = mesh(new THREE.BoxGeometry(0.06, wh, chordAt(1) * 0.9), WS.mat, X(1), wh / 2, zAt(1) - 0.05); wl.rotation.z = -sx * 0.25; hw.add(wl);
      }
      if (wt >= 4) {                                      // карбон / феникс: передняя кромка, винглеты
        const edge = wt === 5 ? std(0xffd23a, glow(0xff9900, 0.9)) : std(0xd4a017, { metalness: 0.36, roughness: 0.25 });
        for (let i = 0; i < 6; i++) { const k0 = i / 6, k1 = (i + 1) / 6, km = (k0 + k1) / 2; const seg = mesh(new THREE.BoxGeometry(half / 6 + 0.02, WS.thick + 0.02, 0.1), edge, X(km), 0, zAt(km) + chordAt(km) / 2 - 0.04, false); seg.rotation.y = sx * Math.atan2(WS.sweep, half); hw.add(seg); }
        const wh = 0.55;
        const wl = mesh(new THREE.BoxGeometry(0.06, wh, chordAt(1)), wt === 5 ? edge : WS.mat, X(1), wh / 2, zAt(1)); wl.rotation.z = -sx * 0.2; hw.add(wl);
        if (wt === 4) for (let i = 0; i < wsub; i++) hw.add(mesh(new THREE.BoxGeometry(0.05, WS.thick + 0.015, chordAt(0.3 + i * 0.13) * 0.8), std(0x2fd0ff, glow(0x1a9fe0, 1)), X(0.3 + i * 0.13), 0, zAt(0.3 + i * 0.13), false));
        if (wt === 5) for (let i = 0; i < 6; i++) {        // перья феникса по задней кромке
          const k = 0.2 + i * 0.15, len = 0.5 + i * 0.08;
          const f = mesh(new THREE.BoxGeometry(0.2, 0.04, len), i % 2 ? edge : WS.mat, X(k), 0, zAt(k) - chordAt(k) / 2 - len / 2 + 0.05, false);
          f.rotation.y = -sx * 0.12; hw.add(f);
        }
      }
      if (wt >= 2) hw.add(mesh(new THREE.SphereGeometry(0.07, 6, 4), sx > 0 ? NAV_L() : NAV_R(), X(1) + sx * 0.03, 0, zAt(1), false));
      g.add(hw);
    }
  }

  // --- Хвост ---
  const T = L.tail, tt = T === 0 ? -1 : T >= 15 ? 3 : tierOf(T), tsub = T >= 15 ? 5 : subOf(T);
  if (T > 0) {
    const finMat = tt === 0 ? std(0xc8a06a) : tt === 3 ? std(0xd4a017, { metalness: 0.36, roughness: 0.25 }) : mP;
    const finGeo = (h, c, sweep) => { const f = new THREE.BoxGeometry(0.1, h, c); const p = f.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) { p.setZ(i, p.getZ(i) * 0.6 - sweep); } f.computeVertexNormals(); return f; };
    const fh = (tt === 0 ? 0.8 : 1.05) + tsub * 0.06;
    const stabSpan = (tt === 0 ? 1.8 : 2.2) + tsub * 0.1;
    g.add(mesh(new THREE.BoxGeometry(stabSpan, 0.08, 0.75), finMat, 0, 0.12, -1.85));
    if (tt <= 1) g.add(mesh(finGeo(fh, 0.95, tt === 0 ? 0.15 : 0.35), finMat, 0, 0.3 + fh / 2, -1.75));
    if (tt >= 2) for (const sx of [-1, 1]) {          // двойной киль на концах стабилизатора
      g.add(mesh(finGeo(fh * 0.85, 0.8, 0.3), finMat, sx * stabSpan / 2, 0.12 + fh * 0.42, -1.85));
      if (tsub >= 3 || tt === 3) g.add(mesh(new THREE.SphereGeometry(0.07, 6, 4), std(0xffffff, glow(0xffffff, 1.2)), sx * stabSpan / 2, 0.12 + fh * 0.85, -2.0, false));
    }
    if (tt === 3) g.add(mesh(new THREE.BoxGeometry(0.1, 0.9, 0.8), std(0x2fd0ff, glow(0x1a9fe0, 0.9)), 0, 0.6, -1.8));
    if (tsub >= 3 && tt <= 1) g.add(mesh(new THREE.BoxGeometry(0.12, fh * 0.85, 0.28), mA, 0, 0.3 + fh * 0.45, -2.3));   // руль направления
    if (tt >= 1) g.add(mesh(new THREE.BoxGeometry(stabSpan * 0.9, 0.1, 0.25), mA, 0, 0.12, -2.3));                  // рули высоты
    if (tt === 1 && tsub >= 4) g.add(mesh(new THREE.BoxGeometry(0.08, 0.3, 1.1), finMat, 0, 0.45, -1.2));            // форкиль
    if (tt <= 1 && tsub >= 5) for (let i = 0; i < 2; i++) g.add(mesh(new THREE.BoxGeometry(0.12, 0.08, 0.6), std(0xf5f6f8), 0, 0.5 + i * 0.25, -1.8 - i * 0.12, false));
    if (tt === 1 && tsub >= 3) g.add(mesh(new THREE.SphereGeometry(0.07, 6, 4), std(0xffffff, glow(0xffffff, 1.2)), 0, 0.3 + fh, -2.1, false));
  } else {
    g.add(mesh(new THREE.BoxGeometry(0.5, 0.5, 0.2), mDark, 0, 0, -2.1));
  }

  // --- Двигатель ---
  const E = L.engine, et = E === 0 ? -1 : E >= 25 ? 5 : tierOf(E), esub = E >= 25 ? 5 : subOf(E);
  const prop = (n, len, bladeMat, hubMat, bladeW = 0.18) => {
    const pg = new THREE.Group();
    pg.add(mesh(new THREE.ConeGeometry(0.2, 0.42, 12).rotateX(Math.PI / 2), hubMat, 0, 0, 0.12));
    for (let i = 0; i < n; i++) {
      const b = mesh(new THREE.BoxGeometry(bladeW, len, 0.05), bladeMat, 0, len / 2 + 0.05, 0); b.rotation.y = 0.35;
      const h = new THREE.Group(); h.rotation.z = i * Math.PI * 2 / n; h.add(b); pg.add(h);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(len + 0.08, 24), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    pg.add(disc); blurs.push(disc); spinners.push(pg);
    return pg;
  };
  const nacelle = (x, y, z, r, len, mat) => g.add(mesh(new THREE.CylinderGeometry(r * 0.85, r, len, 12).rotateX(Math.PI / 2), mat, x, y, z));
  const flameMat = (c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
  const jet = (x, y, z, r, col) => {
    nacelle(x, y, z, r, 1.5, mMetal);
    g.add(mesh(new THREE.TorusGeometry(r * 0.9, 0.05, 6, 16), mDark, x, y, z + 0.75));
    const fan = new THREE.Group(); fan.position.set(x, y, z + 0.7);
    for (let i = 0; i < 8; i++) { const b = mesh(new THREE.BoxGeometry(0.06, r * 0.8, 0.02), mDark, 0, r * 0.4, 0); const h = new THREE.Group(); h.rotation.z = i * Math.PI / 4; h.add(b); fan.add(h); }
    g.add(fan); spinners.push(fan);
    g.add(mesh(new THREE.CylinderGeometry(r * 0.7, r * 0.85, 0.35, 12).rotateX(Math.PI / 2), mDark, x, y, z - 0.9));
    const fl = new THREE.Mesh(new THREE.ConeGeometry(r * 0.65, 1.4, 10).rotateX(-Math.PI / 2), flameMat(col));
    fl.position.set(x, y, z - 1.75); fl.visible = false; g.add(fl); flames.push(fl);
  };
  if (et >= 0 && et <= 2) {
    const bladeMat = et === 0 ? (esub >= 5 ? std(0x8a6a3a) : std(0x3a2a1a)) : mMetal;
    const cowlR = et === 0 ? 0.48 : 0.62;
    g.add(mesh(new THREE.CylinderGeometry(cowlR, cowlR * 0.92, 0.55, 14).rotateX(Math.PI / 2), et === 0 ? mDark : mP, 0, 0, 2.05));
    if (et === 1) for (let i = 0; i < 4 + esub; i++) {    // цилиндры звездообразного мотора
      const a = i / (4 + esub) * Math.PI * 2;
      g.add(mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.28, 6).rotateX(Math.PI / 2), mMetal, Math.cos(a) * 0.5, Math.sin(a) * 0.5, 2.3));
    }
    const n = et === 0 ? 2 : et === 1 ? 3 : (esub >= 4 ? 4 : 3);
    const len = (et === 0 ? 0.75 : 0.95) + esub * 0.05;
    const p0 = prop(n, len, bladeMat, et === 0 && esub < 3 ? mDark : mA); p0.position.set(0, 0, 2.38); g.add(p0);
    if (et === 0 && esub >= 5) p0.children.slice(1, 1 + n).forEach((h) => h.add(mesh(new THREE.BoxGeometry(0.19, 0.12, 0.06), std(0xf1c40f), 0, len, 0, false)));
    if (et >= 1) for (let i = 0; i < Math.min(esub, 4); i++) for (const sx of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.4, 6).rotateX(Math.PI / 2.4), mDark, sx * 0.5, -0.15 - i * 0.12, 1.55));
    if (et === 2) for (const sx of [-1, 1]) {               // ещё два мотора на крыльях
      const x = sx * Math.max(1.5, half * 0.42), z = 0.85;
      nacelle(x, -0.22, z, 0.3, 1.3, mP);
      const pw = prop(n, 0.7 + esub * 0.03, mMetal, mA, 0.15); pw.position.set(x, -0.22, z + 0.72); g.add(pw);
    }
  }
  if (et === 3) {                                           // импеллеры в кольцевых каналах
    g.add(mesh(new THREE.ConeGeometry(0.3, 0.6, 12).rotateX(Math.PI / 2), mA, 0, 0, 2.2));
    const pos = [[1.15, 0.15, -0.7]]; if (esub >= 4) pos.push([Math.max(2.0, half * 0.6), -0.2, 0.5]);
    for (const [px, py, pz] of pos) for (const sx of [-1, 1]) {
      const r = 0.42 + esub * 0.02;
      g.add(mesh(new THREE.CylinderGeometry(r + 0.08, r + 0.08, 0.7, 18, 1, true).rotateX(Math.PI / 2), std(paint, { side: THREE.DoubleSide, roughness: 0.5 }), sx * px, py, pz));
      g.add(mesh(new THREE.TorusGeometry(r + 0.08, 0.06, 6, 18), mA, sx * px, py, pz + 0.35));
      const fan = new THREE.Group(); fan.position.set(sx * px, py, pz);
      fan.add(mesh(new THREE.SphereGeometry(0.12, 8, 6), mDark));
      for (let i = 0; i < 6; i++) { const b = mesh(new THREE.BoxGeometry(0.12, r * 0.95, 0.03), mMetal, 0, r * 0.5, 0); b.rotation.y = 0.4; const h = new THREE.Group(); h.rotation.z = i * Math.PI / 3; h.add(b); fan.add(h); }
      g.add(fan); spinners.push(fan);
      g.add(mesh(new THREE.BoxGeometry(Math.abs(px) - 0.3, 0.08, 0.3), mDark, sx * (Math.abs(px) + 0.3) / 2, py, pz));
    }
  }
  if (et >= 4) {                                            // реактивные двигатели
    g.add(mesh(new THREE.ConeGeometry(bodyR * 0.95, 0.7, 14).rotateX(Math.PI / 2), mA, 0, 0, 2.45));
    const col = et === 5 ? 0x5ab4ff : 0xff8a2a;
    jet(1.05, -0.2, -0.2, 0.3, col); jet(-1.05, -0.2, -0.2, 0.3, col);
    if (esub >= 3 || et === 5) { const x = Math.max(2.0, half * 0.55); jet(x, -0.35, 0.3, 0.26, col); jet(-x, -0.35, 0.3, 0.26, col); }
    if (et === 5) {                                         // ракетный ускоритель на спине
      g.add(mesh(new THREE.CylinderGeometry(0.34, 0.34, 2.6, 14).rotateX(Math.PI / 2), std(0xf5f6f8, { roughness: 0.4 }), 0, 0.85, -0.6));
      g.add(mesh(new THREE.ConeGeometry(0.34, 0.8, 14).rotateX(Math.PI / 2), std(0xe74c3c), 0, 0.85, 1.1));
      for (let i = 0; i < 3; i++) { const f = mesh(new THREE.BoxGeometry(0.05, 0.5, 0.6), std(0xe74c3c), 0, 0, 0); const h = new THREE.Group(); h.position.set(0, 0.85, -1.7); h.rotation.z = i * Math.PI * 2 / 3; f.position.y = 0.45; h.add(f); g.add(h); }
      const fl = new THREE.Mesh(new THREE.ConeGeometry(0.3, 2.4, 12).rotateX(-Math.PI / 2), flameMat(0x9fd8ff));
      fl.position.set(0, 0.85, -3.1); fl.visible = false; g.add(fl); flames.push(fl);
    }
  }

  // --- Топливные баки ---
  if (E > 0) {
    const F = L.fuel;
    if (F >= 3) g.add(mesh(new THREE.CapsuleGeometry(0.2 + Math.min(F, 6) * 0.025, 1.1 + Math.min(F, 6) * 0.08, 4, 10).rotateX(Math.PI / 2), mA, 0, -0.62, 0.2));
    if (F >= 6) for (const sx of [-1, 1]) g.add(mesh(new THREE.CapsuleGeometry(0.17, 0.9, 4, 10).rotateX(Math.PI / 2), mMetal, sx * Math.max(1.3, half * 0.35), -0.55, 0.4));
    if (F >= 8 && W > 0) for (const sx of [-1, 1]) g.add(mesh(new THREE.CapsuleGeometry(0.15, 0.8, 4, 10).rotateX(Math.PI / 2), mA, sx * half * 0.98, -0.2, 0.2));
    if (F >= 10) g.add(mesh(new THREE.CapsuleGeometry(0.22, 1.2, 4, 10).rotateX(Math.PI / 2), std(0xd4a017, { metalness: 0.36, roughness: 0.25 }), 0, bodyR + 0.05, -0.9));
  }
  // --- Шасси ---
  if (L.gear > 0) {
    // Та же форма, меняются материалы: чёрная сталь → хром с красными дисками → золото с белыми боковинами
    const G = [null,
      { strut: mDark, tire: std(0x1a1a1a), hub: std(0x6b6b6b) },
      { strut: std(0xe6ebf0, { metalness: 0.4, roughness: 0.15 }), tire: std(0x141414), hub: std(0xd0302a, { roughness: 0.3 }) },
      { strut: std(0xd4a017, { metalness: 0.4, roughness: 0.2 }), tire: std(0xf2f2f2, { roughness: 0.6 }), hub: std(0xffd23a, glow(0xb07800, 0.5)) },
    ][Math.min(3, L.gear)];
    for (const sx of [-1, 1]) {
      g.add(mesh(new THREE.BoxGeometry(0.08, 0.6, 0.08), G.strut, sx * 0.55, -0.6, 0.9));
      g.add(mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.16, 12).rotateZ(Math.PI / 2), G.tire, sx * 0.6, -0.92, 0.9));
      g.add(mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.18, 10).rotateZ(Math.PI / 2), G.hub, sx * 0.6, -0.92, 0.9, false));
    }
    g.add(mesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), G.strut, 0, -0.4, -1.8));
    g.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.1, 10).rotateZ(Math.PI / 2), G.tire, 0, -0.55, -1.8));
  }
  g.userData = { span, spinners, flames, blurs, paint: at === -1 ? 0xb08a5a : paint };
  return g;
}
function animateEngines(dt, spin, on) {
  const u = plane.userData;
  for (const sp of u.spinners) sp.rotation.z += spin * dt;
  for (const b of u.blurs) b.material.opacity = on ? 0.25 : 0;
  for (const f of u.flames) { f.visible = on; if (on) f.scale.set(1, 1, 0.8 + Math.random() * 0.4); }
}
function rebuildPlane() {
  const prev = plane;
  plane = buildPlaneMesh(save.lv);
  if (prev) { plane.position.copy(prev.position); plane.quaternion.copy(prev.quaternion); scene.remove(prev); }
  scene.add(plane);
  S = computeStats(save.lv);
}
// =====================================================================
//  Звук (WebAudio, синтез)
// =====================================================================

const Sound = {
  ctx: null, wind: null, windGain: null, eng: null, engGain: null, master: null,
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      const ctx = this.ctx = new C();
      this.master = ctx.createGain(); this.master.gain.value = save.sound ? 0.6 : 0; this.master.connect(ctx.destination);
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.6;
      this.windGain = ctx.createGain(); this.windGain.gain.value = 0; this.windFilter = bp;
      src.connect(bp).connect(this.windGain).connect(this.master); src.start();
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 60;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      this.engGain = ctx.createGain(); this.engGain.gain.value = 0; this.eng = o;
      o.connect(lp).connect(this.engGain).connect(this.master); o.start();
    } catch (e) { this.ctx = null; }
  },
  setMuted(m) { if (this.master) this.master.gain.value = m ? 0 : 0.6; },
  update(speed, throttle) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(clamp(speed / 90, 0, 1) * 0.11, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(300 + speed * 12, t, 0.1);
    this.engGain.gain.setTargetAtTime(throttle ? 0.12 : 0, t, 0.05);
    this.eng.frequency.setTargetAtTime(55 + speed * 1.4 + (throttle ? 25 : 0), t, 0.1);
  },
  blip(freq, dur = 0.12, type = 'sine', vol = 0.25) {
    if (!this.ctx) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(freq * 1.5, ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    o.connect(g).connect(this.master); o.start(); o.stop(ctx.currentTime + dur);
  },
  // Звон монеты в духе Марио: короткая «си», затем звонкая «ми» на октаву выше с затуханием
  coin() {
    if (!this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    for (const [f, start, dur] of [[988, 0, 0.07], [1319, 0.07, 0.38]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.setValueAtTime(f, t0 + start);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.setValueAtTime(0.09, t0 + start);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      o.connect(g).connect(this.master); o.start(t0 + start); o.stop(t0 + start + dur + 0.02);
    }
  },
  thud(vol = 0.6, dur = 0.5) {
    if (!this.ctx) return;
    const ctx = this.ctx, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = this.noise; f.type = 'lowpass'; f.frequency.value = 400;
    g.gain.setValueAtTime(vol, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    s.connect(f).connect(g).connect(this.master); s.start(); s.stop(ctx.currentTime + dur);
  },
};

// =====================================================================
//  Частицы
// =====================================================================

const particles = [];
const puffGeo = new THREE.IcosahedronGeometry(0.5, 0);
const debrisGeo = new THREE.BoxGeometry(0.5, 0.25, 0.6);
function spawnPuff(pos, color = 0xdddddd, size = 1, life = 1.2, vel = null) {
  const m = new THREE.Mesh(puffGeo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, transparent: true, opacity: 0.7, flatShading: true, depthWrite: false }));
  m.position.copy(pos); m.scale.setScalar(size);
  scene.add(m);
  particles.push({ m, vel: vel || new V3((Math.random() - 0.5) * 1.5, 1 + Math.random(), (Math.random() - 0.5) * 1.5), life, max: life, grow: 1.6, grav: 0 });
}
function spawnDebris(pos, vel, colors) {
  for (let i = 0; i < 26; i++) {
    const m = new THREE.Mesh(debrisGeo, std(colors[i % colors.length]));
    m.castShadow = true;
    m.position.copy(pos);
    m.scale.setScalar(0.5 + Math.random());
    scene.add(m);
    const v = vel.clone().multiplyScalar(0.35).add(new V3((Math.random() - 0.5) * 16, Math.random() * 12, (Math.random() - 0.5) * 16));
    particles.push({ m, vel: v, life: 3 + Math.random() * 2, max: 5, grow: 0, grav: G, spin: new V3(Math.random() * 8, Math.random() * 8, Math.random() * 8), debris: true });
  }
  for (let i = 0; i < 14; i++) spawnPuff(pos.clone().add(new V3((Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3)), i % 2 ? 0x555555 : 0xffa040, 1.5 + Math.random() * 1.5, 1.6);
}
// Расходящиеся круги на воде
const ripples = [];
const rippleGeo = new THREE.RingGeometry(0.8, 1.0, 40).rotateX(-Math.PI / 2);
function spawnRipple(pos, delay = 0) {
  const m = new THREE.Mesh(rippleGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
  m.position.set(pos.x, WATER_Y + 0.05, pos.z);
  scene.add(m);
  ripples.push({ m, t: -delay });
}
function updateRipples(dt) {
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.t += dt;
    if (r.t < 0) continue;
    const k = r.t / 2.2;
    r.m.scale.setScalar(1 + k * 9);
    r.m.material.opacity = 0.7 * (1 - k);
    if (k >= 1) { scene.remove(r.m); r.m.material.dispose(); ripples.splice(i, 1); }
  }
}
function updateSinking(dt) {
  P.sinkT += dt;
  const t = P.sinkT;
  P.vel.multiplyScalar(Math.max(0, 1 - dt * 1.5));
  P.pos.x += P.vel.x * dt; P.pos.z += P.vel.z * dt;
  P.pos.y = WATER_Y + 0.2 - Math.min(5, t * t * 0.55);          // сначала держится на воде, потом всё быстрее уходит вниз
  P.q.multiply(_dq.setFromAxisAngle(_l.set(1, 0, 0), dt * 0.35));  // клюёт носом
  P.q.multiply(_dq.setFromAxisAngle(_l.set(0, 0, 1), dt * 0.12 * Math.sin(t * 2)));  // покачивается
  P.bubbleT = (P.bubbleT || 0) + dt;
  if (P.bubbleT > 0.08 && t < 3) {
    P.bubbleT = 0;
    spawnPuff(new V3(P.pos.x + (Math.random() - 0.5) * 2, WATER_Y + 0.1, P.pos.z + (Math.random() - 0.5) * 2), 0xffffff, 0.25 + Math.random() * 0.2, 0.6, new V3(0, 1.2, 0));
  }
  if (Math.floor((t - dt) / 0.7) !== Math.floor(t / 0.7) && t < 2.5) spawnRipple(P.pos);
}
// Искры подбора монеты: пара жёлтых звёздочек разлетается в стороны и мерцает, как кольца в Сонике
const sparkTex = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,230,1)'); grd.addColorStop(0.25, 'rgba(255,230,90,.9)'); grd.addColorStop(1, 'rgba(255,200,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,250,200,1)';
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = i % 2 ? 6 : 30; g.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
  g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const sparks = [];
function spawnSparks(pos) {
  const n = 3 + Math.floor(Math.random() * 2), a0 = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkTex, color: 0xffd23a, transparent: true, depthWrite: false }));
    sp.position.copy(pos);
    const a = a0 + i * Math.PI * 2 / n;
    sparks.push({ sp, vel: new V3(Math.cos(a) * 7, 3 + Math.sin(a) * 5, (Math.random() - 0.5) * 3), life: 0, max: 0.5 });
    scene.add(sp);
  }
}
function updateSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life += dt;
    const k = s.life / s.max;
    s.sp.position.addScaledVector(s.vel, dt);
    s.vel.multiplyScalar(Math.max(0, 1 - dt * 3));
    s.sp.scale.setScalar(0.6 * (1 - k * 0.7) * (0.7 + 0.3 * Math.sin(s.life * 40)));
    s.sp.material.opacity = 1 - k * k;
    s.sp.material.rotation += dt * 6;
    if (k >= 1) { scene.remove(s.sp); s.sp.material.dispose(); sparks.splice(i, 1); }
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vel.y -= p.grav * dt;
    p.m.position.addScaledVector(p.vel, dt);
    if (p.debris) {
      const gh = terrainH(p.m.position.x, p.m.position.z);
      if (p.m.position.y < gh + 0.15) { p.m.position.y = gh + 0.15; p.vel.multiplyScalar(0.4); p.vel.y = Math.abs(p.vel.y) * 0.3; p.spin.multiplyScalar(0.5); }
      p.m.rotation.x += p.spin.x * dt; p.m.rotation.y += p.spin.y * dt;
    } else {
      p.m.scale.multiplyScalar(1 + p.grow * dt);
      p.m.material.opacity = 0.7 * (p.life / p.max);
    }
    if (p.life <= 0) { scene.remove(p.m); if (!p.debris) p.m.material.dispose(); particles.splice(i, 1); }
  }
}

// =====================================================================
//  Физика полёта
// =====================================================================

const P = {
  pos: new V3(), vel: new V3(), q: new THREE.Quaternion(), w: new V3(),
  fuel: 0, throttle: false, onGround: false, stopTimer: 0, ended: false, endTime: 0,
  maxZ: 0, coins: 0, rings: 0, bounces: 0, landed: false, reason: '', finished: false, turb: new V3(), time: 0, lastImpact: 0, airTime: 0,
  prevNose: new V3(), prevTail: new V3(), lastFurrow: new V3(), bellyDown: false,
};
const keys = {};
const _f = new V3(), _u = new V3(), _l = new V3(), _F = new V3(), _vd = new V3(), _vb = new V3(), _tmp = new V3(), _tmp2 = new V3(), _qi = new THREE.Quaternion(), _dq = new THREE.Quaternion();

const airDensity = (y) => clamp(1 - Math.max(0, y - THIN_AIR) / 90, 0.12, 1);
function liftCoef(a) {
  const x = Math.abs(a), s = Math.sign(a);
  if (x < 0.27) return 5.2 * a;
  if (x < 0.6) return s * (1.4 - (x - 0.27) * 2.0);
  return 0.72 * Math.sin(2 * a);
}

// Сенсорное управление: джойстик слева (тангаж/крен), кнопка справа (двигатель / натяжение)
const touch = { x: 0, y: 0, btn: false };
function input() {
  const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
  let pitch = clamp((up ? 1 : 0) - (down ? 1 : 0) - touch.y, -1, 1);
  if (save.invert) pitch = -pitch;
  const roll = clamp((keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + touch.x, -1, 1);
  const yaw = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
  const throttle = !!(keys.Space || keys.ShiftLeft || keys.ShiftRight || touch.btn);
  return { pitch, roll, yaw, throttle };
}

function physicsStep(dt, inp) {
  const q = P.q;
  _f.set(0, 0, 1).applyQuaternion(q);
  _u.set(0, 1, 0).applyQuaternion(q);
  _l.set(1, 0, 0).applyQuaternion(q);
  const v = P.vel.length();
  const rho = airDensity(P.pos.y);
  _F.set(0, -G, 0);
  const tq = _tmp.set(0, 0, 0);
  let alpha = 0, beta = 0;

  if (v > 0.3) {
    _vd.copy(P.vel).divideScalar(v);
    _qi.copy(q).invert();
    _vb.copy(P.vel).applyQuaternion(_qi);
    alpha = Math.atan2(-_vb.y, _vb.z);
    beta = Math.atan2(_vb.x, _vb.z);
    const qd = v * v * rho;

    // Подъёмная сила: перпендикулярна скорости и размаху крыла
    const cl = liftCoef(alpha);
    const liftDir = _tmp2.copy(_vd).cross(_l);
    if (liftDir.lengthSq() > 1e-6) {
      liftDir.normalize();
      let L = S.liftK * qd * cl + 0.0025 * qd * Math.sin(2 * alpha) * 0.5;
      L = clamp(L, -6 * G, 7 * G);          // аркадное ограничение перегрузки
      _F.addScaledVector(liftDir, L);
    }
    // Боковая сила фюзеляжа и киля
    const sideDir = _tmp2.copy(_u).cross(_vd);
    if (sideDir.lengthSq() > 1e-6) { sideDir.normalize(); _F.addScaledVector(sideDir, -S.sideK * qd * Math.sin(beta)); }
    // Сопротивление: паразитное + индуктивное + от углов атаки/скольжения
    const sa = Math.sin(alpha), sb = Math.sin(beta);
    const cd = S.cd0 + S.liftK * 0.09 * cl * cl + 0.0035 * (sa * sa + sb * sb);
    _F.addScaledVector(_vd, -cd * qd);

    // Моменты (в связанной системе: x — тангаж, y — рыскание, z — крен)
    const aC = Math.sin(clamp(alpha, -1.5, 1.5)), bC = Math.sin(clamp(beta, -1.5, 1.5));
    tq.x += S.pitchStab * qd * aC;
    tq.y += S.yawStab * qd * bC;
    const ctrlScale = Math.min(1, v / 12) * rho;
    tq.x += -inp.pitch * (S.pitchCtrl * qd + S.pitchBase * ctrlScale);
    tq.z += inp.roll * (S.rollCtrl * qd + S.rollBase * ctrlScale);
    tq.y += -inp.roll * 0.45 * (S.yawCtrl * qd + S.yawBase * ctrlScale);
    tq.y += -inp.yaw * (S.yawCtrl * qd + S.yawBase * ctrlScale);
    // Аркадные помощники: выравнивание крена и координированный разворот
    if (!inp.roll && _u.y > 0) tq.z += -_l.y * S.levelK * ctrlScale * 2.2;
    tq.y += -_l.y * S.turnK * ctrlScale * Math.max(0, _u.y);
    // Демпфирование
    tq.x -= P.w.x * (S.pitchDamp * v * rho + 0.35);
    tq.y -= P.w.y * (S.yawDamp * v * rho + 0.35);
    tq.z -= P.w.z * (S.rollDamp * v * rho + 0.3);
    // Без хвоста самолёт неустойчив — болтанка
    P.turb.x += ((Math.random() - 0.5) * 30 - P.turb.x * 2.5) * dt;
    P.turb.y += ((Math.random() - 0.5) * 30 - P.turb.y * 2.5) * dt;
    const turbK = S.wobble * Math.min(1, v / 18) * rho;
    tq.x += P.turb.x * turbK; tq.y += P.turb.y * turbK * 0.8;

    // Аркадное «доворачивание» скорости к носу (крылья лучше направляют поток)
    const ang = _vd.angleTo(_f);
    if (ang > 1e-4 && ang < 0.6 && !P.onGround) {
      const k = Math.min(1, S.align * dt * Math.min(1, v / 22) * rho);
      _tmp2.copy(_vd).lerp(_f, k).normalize().multiplyScalar(v);
      P.vel.copy(_tmp2);
    }
  }

  // Тяга двигателя
  P.throttle = false;
  if (inp.throttle && P.fuel > 0 && S.thrust > 0) {
    const eff = clamp(1 - v / S.propVmax, 0, 1);
    _F.addScaledVector(_f, S.thrust * rho * (0.25 + 0.75 * eff));
    P.fuel = Math.max(0, P.fuel - dt);
    P.throttle = true;
  }

  // Интеграция вращения
  P.w.addScaledVector(tq, dt);
  P.w.clampLength(0, 7);
  const wl = P.w.length();
  if (wl > 1e-6) { _dq.setFromAxisAngle(_tmp2.copy(P.w).divideScalar(wl), wl * dt); q.multiply(_dq).normalize(); }

  // Интеграция движения
  P.vel.addScaledVector(_F, dt);
  P.pos.addScaledVector(P.vel, dt);

  groundContact(dt);
}

// Борозда от посадки на брюхо: тёмные полосы взрытой земли за самолётом
const furrows = [];
const furrowGeo = new THREE.BoxGeometry(1.1, 0.12, 0.8);
const furrowMat = new THREE.MeshLambertMaterial({ color: 0x4a3420, flatShading: true });
const moundMat = new THREE.MeshLambertMaterial({ color: 0x7a5a36, flatShading: true });
const moundGeo = new THREE.BoxGeometry(0.35, 0.22, 0.8);
function addFurrow(pos, heading, n) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(furrowGeo, furrowMat));
  for (const sx of [-0.72, 0.72]) { const m = new THREE.Mesh(moundGeo, moundMat); m.position.set(sx, 0.08, 0); g.add(m); }
  const y = terrainH(pos.x, pos.z);
  g.position.set(pos.x, y + 0.02, pos.z);
  const fw = new V3(Math.sin(heading), 0, Math.cos(heading));
  fw.addScaledVector(n, -fw.dot(n)).normalize();
  g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new V3().crossVectors(n, fw), n, fw));
  g.children.forEach((c) => { c.receiveShadow = true; });
  scene.add(g);
  furrows.push(g);
}
function clearFurrows() { for (const g of furrows) scene.remove(g); furrows.length = 0; }

// Поверхность под точкой: рельеф, настил моста или вода
function onBridge(x, z) { return Math.abs(x - BRIDGE_X) < 3.1 && Math.abs(z - RIVER_Z) < BRIDGE_HALF_LEN; }
function groundContact(dt) {
  const bridge = onBridge(P.pos.x, P.pos.z);
  const gh = bridge ? bridgeDeckY(P.pos.z) : terrainH(P.pos.x, P.pos.z);
  const inRiver = !bridge && Math.abs(P.pos.z - RIVER_Z) < 23 && gh < WATER_Y;
  const surf = inRiver ? WATER_Y : gh;
  const clearance = S.gear ? 1.15 : 0.5;
  // Севший на брюхо крылатый самолёт уже не взлетит: прижимаем его к земле до остановки
  if (P.bellyDown && !inRiver) P.pos.y = Math.min(P.pos.y, surf + clearance);
  if (P.pos.y - clearance > surf) {
    if (P.onGround && P.pos.y - clearance > surf + 0.4) P.onGround = false;
    return;
  }
  const vy = -P.vel.y;
  _u.set(0, 1, 0).applyQuaternion(P.q);
  _f.set(0, 0, 1).applyQuaternion(P.q);
  if (inRiver) { endFlight('splash'); return; }

  const crashVy = S.gear ? 24 : 20;
  if (!P.onGround) {
    if (vy > crashVy || (_u.y < -0.2 && vy > 6) || (_f.y < -0.75 && vy > 12)) { P.pos.y = surf + clearance; endFlight('crash', 'Удар о землю'); return; }
    // Отскакивает только бескрылая «коробка» и самолёт на шасси;
    // крылатый без шасси садится на брюхо и пашет землю
    if (vy > 4.5 && (S.gear || S.liftK === 0)) {
      // Отскок
      P.vel.y = vy * (S.gear ? 0.32 : 0.42);
      P.vel.x *= S.gear ? 0.9 : 0.78; P.vel.z *= S.gear ? 0.9 : 0.78;
      P.w.multiplyScalar(0.5);
      P.w.x += (Math.random() - 0.5) * 2;
      P.bounces++;
      P.pos.y = surf + clearance;
      Sound.thud(0.5, 0.3);
      for (let i = 0; i < 5; i++) spawnPuff(P.pos.clone().add(new V3((Math.random() - 0.5) * 2, -0.5, 0)), 0xc9b48a, 1, 1);
      if (P.bounces <= 6) toast('Отскок!');
      return;
    }
    P.onGround = true;
    P.lastImpact = vy;
    Sound.thud(S.gear ? 0.3 : 0.55, S.gear ? 0.25 : 0.45);
    if (!S.gear && S.liftK > 0) {
      P.bellyDown = true;
      for (let i = 0; i < 10; i++) spawnPuff(P.pos.clone().add(new V3((Math.random() - 0.5) * 3, -0.3, (Math.random() - 0.5) * 3)), 0xa88a5c, 1.2, 1.1);
      P.w.set(0, 0, 0);
    }
  }
  P.pos.y = surf + clearance;
  if (P.vel.y < 0) P.vel.y = 0;
  // Трение качения / скольжения
  const hv = Math.hypot(P.vel.x, P.vel.z);
  const belly = !S.gear && S.liftK > 0;      // крылья мешают скользить: тормозим резко
  const fr = (S.gear ? S.rollFr : belly ? 20 + hv * 0.9 : 7.5) * dt;
  if (hv > 0) { const k = Math.max(0, hv - fr) / hv; P.vel.x *= k; P.vel.z *= k; }
  // Ложимся по склону: «верх» самолёта — нормаль рельефа, нос — по курсу движения
  const heading = Math.atan2(P.vel.x || _f.x, P.vel.z || _f.z);
  const n = _tmp.set(terrainH(P.pos.x - 1, P.pos.z) - terrainH(P.pos.x + 1, P.pos.z), 2, terrainH(P.pos.x, P.pos.z - 1) - terrainH(P.pos.x, P.pos.z + 1)).normalize();
  if (inRiver || bridge) n.set(0, 1, 0);
  const fw = _tmp2.set(Math.sin(heading), 0, Math.cos(heading));
  fw.addScaledVector(n, -fw.dot(n)).normalize();
  const side = _vb.crossVectors(n, fw);
  _qi.setFromRotationMatrix(_m4.makeBasis(side, n, fw));
  if (S.gear) _qi.multiply(_dq.setFromAxisAngle(_l.set(1, 0, 0), -0.06));
  P.q.slerp(_qi, Math.min(1, dt * 4));
  P.w.multiplyScalar(Math.max(0, 1 - dt * 6));
  if (!S.gear && hv > 4 && Math.random() < dt * 25) spawnPuff(P.pos.clone().add(new V3(0, -0.4, 0)), 0xc9b48a, 0.8, 0.8);
  if (!S.gear && hv > 0.8 && !inRiver && !bridge && P.pos.distanceToSquared(P.lastFurrow) > 0.36) { addFurrow(P.pos, heading, n); P.lastFurrow.copy(P.pos); }
  if (hv < 1.5 && !(P.throttle)) { P.stopTimer += dt; if (P.stopTimer > 0.6) endFlight('landed'); }
  else P.stopTimer = 0;
}

// --- Столкновения ---
function hitPrim(p, pr, rad) {
  switch (pr.t) {
    case 'cone': {      // вертикальный конус: радиус r0 у основания сходится к нулю на вершине
      if (p.y < pr.y0 - rad || p.y > pr.y1 + rad) return false;
      const k = clamp((p.y - pr.y0) / (pr.y1 - pr.y0), 0, 1);
      const rr = pr.r0 * (1 - k) + rad;
      const dx = p.x - pr.x, dz = p.z - pr.z;
      return dx * dx + dz * dz < rr * rr;
    }
    case 'cyl': {
      if (p.y < pr.y0 - rad || p.y > pr.y1 + rad) return false;
      const dx = p.x - pr.x, dz = p.z - pr.z, rr = pr.r + rad;
      return dx * dx + dz * dz < rr * rr;
    }
    case 'sph': { const rr = pr.r + rad; return p.distanceToSquared(pr.c) < rr * rr; }
    case 'box': {
      const cx = clamp(p.x, pr.min.x, pr.max.x), cy = clamp(p.y, pr.min.y, pr.max.y), cz = clamp(p.z, pr.min.z, pr.max.z);
      const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
      return dx * dx + dy * dy + dz * dz < rad * rad;
    }
    case 'seg': {
      const ax = pr.b.x - pr.a.x, ay = pr.b.y - pr.a.y, az = pr.b.z - pr.a.z;
      const len2 = ax * ax + ay * ay + az * az;
      let t = len2 > 0 ? ((p.x - pr.a.x) * ax + (p.y - pr.a.y) * ay + (p.z - pr.a.z) * az) / len2 : 0;
      t = clamp(t, 0, 1);
      const dx = p.x - (pr.a.x + ax * t), dy = p.y - (pr.a.y + ay * t), dz = p.z - (pr.a.z + az * t);
      const rr = pr.r + rad;
      return dx * dx + dy * dy + dz * dz < rr * rr;
    }
    case 'torus': {
      const dx = p.x - pr.c.x, dy = p.y - pr.c.y, dz = p.z - pr.c.z;
      const rad2 = Math.hypot(dx, dy) - pr.R;
      const rr = pr.r + rad;
      return rad2 * rad2 + dz * dz < rr * rr;
    }
  }
  return false;
}
const probes = [new V3(), new V3(), new V3(), new V3()];
function checkCollisions() {
  const pz = P.pos.z;
  _l.set(1, 0, 0).applyQuaternion(P.q);
  _f.set(0, 0, 1).applyQuaternion(P.q);
  const half = S.span / 2 * 0.85;
  probes[0].copy(P.pos);
  probes[1].copy(P.pos).addScaledVector(_f, 1.5);
  const nProbes = half > 0 ? 4 : 2;
  if (half > 0) { probes[2].copy(P.pos).addScaledVector(_l, half); probes[3].copy(P.pos).addScaledVector(_l, -half); }
  const radii = [0.75, 0.5, 0.4, 0.4];
  for (const o of obstacles) {
    if (o.zMin > pz + 12) break;
    if (o.zMax < pz - 12) continue;
    for (const pr of o.prims) for (let i = 0; i < nProbes; i++) if (hitPrim(probes[i], pr, radii[i])) return true;
  }
  return false;
}

const COIN_PICK_R = COIN_R * 1.35;     // зона подбора чуть больше самой монеты
function distToSeg(p, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2, 0, 1) : 0;
  return Math.hypot(p.x - a.x - abx * t, p.y - a.y - aby * t, p.z - a.z - abz * t);
}
const _wl = new V3(), _wr = new V3(), _tail = new V3();
function collectStuff() {
  // Монету собирает любая часть самолёта: фюзеляж (с учётом пролёта за кадр) или крылья
  _f.set(0, 0, 1).applyQuaternion(P.q);
  _l.set(1, 0, 0).applyQuaternion(P.q);
  _tail.copy(P.pos).addScaledVector(_f, -2.1);
  const half = S.span / 2;
  _wl.copy(P.pos).addScaledVector(_l, half); _wr.copy(P.pos).addScaledVector(_l, -half);
  for (const c of coins) {
    if (c.taken) continue;
    if (Math.abs(c.pos.z - P.pos.z) > 8) continue;
    const hit = distToSeg(c.pos, P.prevNose, _tail) < COIN_PICK_R + 0.5 || (half > 0 && distToSeg(c.pos, _wl, _wr) < COIN_PICK_R + 0.15);
    if (hit) {
      // Монета просто исчезает, оставив несколько искорок
      c.taken = true; c.anim = 1;
      P.coins += 20;
      Sound.coin();
      spawnSparks(c.pos);
    }
  }
  // Кольцо засчитывается, только если сквозь него прошёл весь фюзеляж:
  // и нос, и хвост пересекли плоскость кольца внутри него (с запасом на толщину корпуса)
  _f.set(0, 0, 1).applyQuaternion(P.q);
  const nose = _tmp.copy(P.pos).addScaledVector(_f, 2.1), tail = _tmp2.copy(P.pos).addScaledVector(_f, -2.1);
  const crossing = (a, b, c) => {
    if ((a.z < c.z) === (b.z < c.z) || b.z < a.z) return null;          // считаем только пролёт вперёд
    const t = (c.z - a.z) / (b.z - a.z);
    return Math.hypot(lerp(a.x, b.x, t) - c.x, lerp(a.y, b.y, t) - c.y);
  };
  for (const r of rings) {
    if (r.taken || Math.abs(r.c.z - P.pos.z) > 12) continue;
    const inner = r.R - r.tube - 0.45;
    const dn = crossing(P.prevNose, nose, r.c);
    if (dn !== null) r.noseOk = dn < inner;
    const dt = crossing(P.prevTail, tail, r.c);
    if (dt === null) continue;
    const ok = r.noseOk && dt < inner;
    r.noseOk = null;
    if (ok) {
      r.taken = true; P.rings++; P.coins += 75;
      r.mesh.material = std(0x6ef08a, { emissive: 0x1d7a33, roughness: 0.4 });
      toast('Кольцо! +75'); Sound.blip(660, 0.25, 'sine', 0.25); setTimeout(() => Sound.blip(990, 0.25, 'sine', 0.2), 90);
    }
  }
  P.prevNose.copy(nose); P.prevTail.copy(tail);
}

// =====================================================================
//  Игровые режимы
// =====================================================================

let mode = 'hangar';
const aim = { pitch: 25, yaw: 0, pull: 0, pulling: false };
const launchBase = new V3(0, 0, 0);

function aimQuat(out) {
  return out.setFromEuler(new THREE.Euler(-aim.pitch * Math.PI / 180, -aim.yaw * Math.PI / 180, 0, 'YXZ'));
}
function placeOnSlingshot() {
  launchBase.set(0, terrainH(0, 0) + SL.rest.y, 0);
  aimQuat(P.q);
  // Резинку оттягиваем назад по курсу и чуть вниз, но хвост не должен уйти под землю
  const yaw = -aim.yaw * Math.PI / 180;
  P.pos.set(launchBase.x - Math.sin(yaw) * aim.pull * 5.5, launchBase.y - aim.pull * 1.2, launchBase.z - Math.cos(yaw) * aim.pull * 5.5);
  const tailDrop = 2.2 * Math.sin(aim.pitch * Math.PI / 180) + (save.lv.gear ? 1.0 : 0.6);
  P.pos.y = Math.max(P.pos.y, terrainH(P.pos.x, P.pos.z) + tailDrop);
  plane.position.copy(P.pos);
  plane.quaternion.copy(P.q);
  plane.visible = true;
  updateBands();
}
function updateBands() {
  const tail = _tmp.set(0, 0, -2.1).applyQuaternion(P.q).add(P.pos);
  pouch.position.copy(tail); pouch.quaternion.copy(P.q);
  const by = terrainH(0, 0);
  setBand(bands[0], new V3(SL.tips[0].x, by + SL.tips[0].y, SL.tips[0].z), tail);
  setBand(bands[1], new V3(SL.tips[1].x, by + SL.tips[1].y, SL.tips[1].z), tail);
}
function relaxBands(dt) {
  const by = terrainH(0, 0);
  const target = new V3(0, by + SL.tips[0].y - 0.2, 1.8);
  pouch.position.lerp(target, Math.min(1, dt * 10));
  pouch.quaternion.identity();
  setBand(bands[0], new V3(SL.tips[0].x, by + SL.tips[0].y, SL.tips[0].z), pouch.position);
  setBand(bands[1], new V3(SL.tips[1].x, by + SL.tips[1].y, SL.tips[1].z), pouch.position);
}

// Пунктир траектории при натяжении (баллистика без учёта крыльев и мотора)
const TRAJ_N = 26;
const trajDots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }), TRAJ_N);
trajDots.frustumCulled = false;
trajDots.visible = false;
scene.add(trajDots);
function updateTrajectory() {
  trajDots.visible = mode === 'aim' && aim.pull > 0.02;
  if (!trajDots.visible) return;
  const q = aimQuat(_qi);
  const p = _tmp.copy(launchBase), v = _tmp2.set(0, 0, 1).applyQuaternion(q).multiplyScalar(S.launch * (0.25 + 0.75 * aim.pull));
  for (let i = 0; i < TRAJ_N; i++) {
    for (let k = 0; k < 6; k++) {
      const sp = v.length(), dt = 1 / 60;
      v.addScaledVector(v, -S.cd0 * sp * dt); v.y -= G * dt;
      p.addScaledVector(v, dt);
    }
    const sc = p.y < terrainH(p.x, p.z) ? 0 : 1 - i / TRAJ_N * 0.5;
    _m4.compose(p, _q.identity(), _s.setScalar(sc));
    trajDots.setMatrixAt(i, _m4);
  }
  trajDots.instanceMatrix.needsUpdate = true;
}

function resetRun() {
  for (const c of coins) { c.taken = false; c.anim = 1; }
  for (const r of rings) { r.taken = false; r.noseOk = null; r.mesh.material = std(0x38d1ff, { emissive: 0x0b5f80, roughness: 0.4 }); }
  clearFurrows();
  Object.assign(P, { fuel: S.fuel, throttle: false, onGround: false, stopTimer: 0, ended: false, maxZ: 0, coins: 0, rings: 0, bounces: 0, landed: false, finished: false, time: 0, reason: '', airTime: 0, bellyDown: false });
  P.w.set(0, 0, 0); P.vel.set(0, 0, 0); P.turb.set(0, 0, 0);
}

// Режим осмотра самолёта: тап по пустому месту в мастерской прячет меню
const insp = { on: false, yaw: 2.4, pitch: 0.25, dist: 11, ptrs: new Map(), pinch: 0 };
function setInspect(on) {
  insp.on = on;
  $('hangar').classList.toggle('hidden', on);
  $('inspect').classList.toggle('hidden', !on);
  if (on) {
    // начинаем с того ракурса, где камера уже стоит, чтобы не было рывка
    const d = _tmp.copy(camPos).sub(plane.position);
    insp.dist = camera.aspect < 1 ? 21 : 15;   // издалека, чтобы рогатка с самолётом целиком влезали в кадр
    insp.yaw = Math.atan2(d.x, d.z);
    insp.pitch = clamp(Math.asin(d.y / Math.max(0.001, d.length())), -0.2, 1.3);
  }
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'hangar') return;
  if (!insp.on) { setInspect(true); return; }
  insp.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!insp.on || !insp.ptrs.has(e.pointerId)) return;
  const p = insp.ptrs.get(e.pointerId);
  if (insp.ptrs.size === 1) {
    insp.yaw -= (e.clientX - p.x) * 0.008;
    insp.pitch = clamp(insp.pitch + (e.clientY - p.y) * 0.006, -0.2, 1.35);
  }
  p.x = e.clientX; p.y = e.clientY;
  if (insp.ptrs.size === 2) {                     // щипок — приближение
    const [a, b] = [...insp.ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (insp.pinch) insp.dist = clamp(insp.dist * insp.pinch / d, 8, 30);
    insp.pinch = d;
  }
});
const inspUp = (e) => { insp.ptrs.delete(e.pointerId); if (insp.ptrs.size < 2) insp.pinch = 0; };
renderer.domElement.addEventListener('pointerup', inspUp);
renderer.domElement.addEventListener('pointercancel', inspUp);
renderer.domElement.addEventListener('wheel', (e) => { if (insp.on) { insp.dist = clamp(insp.dist * (1 + Math.sign(e.deltaY) * 0.1), 8, 30); e.preventDefault(); } }, { passive: false });
$('insp-back').addEventListener('click', () => setInspect(false));
// Полоса над мастерской на телефоне принадлежит просмотрщику и касания туда не доходят,
// поэтому пустая часть шапки «Мастерская» тоже открывает осмотр
document.querySelector('#shop header').addEventListener('click', (e) => {
  if (e.target.closest('button, .money')) return;
  if (mode === 'hangar') setInspect(true);
});

function enterHangar() {
  mode = 'hangar';
  if (insp.on) setInspect(false);
  aim.pull = 0; aim.pulling = false;
  buildSlingshot();
  rebuildPlane();
  resetRun();
  placeOnSlingshot();
  show('hangar'); hide('hud'); hide('aim'); hide('aim-hint'); hide('result');
  renderShop();
  Sound.update(0, false);
}
function enterAim() {
  Sound.init();
  mode = 'aim';
  resetRun();
  aim.pull = 0; aim.pulling = false;
  placeOnSlingshot();
  hide('hangar'); hide('settings'); show('aim'); show('aim-hint'); hide('hud');
  updateAimHud();
}
function launch() {
  const power = 0.25 + 0.75 * aim.pull;
  aimQuat(P.q);
  _f.set(0, 0, 1).applyQuaternion(P.q);
  P.vel.copy(_f).multiplyScalar(S.launch * power);
  P.w.set(0, 0, 0);
  P.prevNose.copy(P.pos).addScaledVector(_f, 2.1); P.prevTail.copy(P.pos).addScaledVector(_f, -2.1);
  P.lastFurrow.set(1e9, 0, 0);
  mode = 'flight';
  camHeading.set(_f.x, 0, _f.z).normalize();
  hide('aim'); hide('aim-hint'); show('hud');
  $('hud-fuel').classList.toggle('hidden', S.thrust <= 0);
  Sound.blip(180, 0.3, 'sawtooth', 0.2);
  aim.pull = 0;
}
function endFlight(reason, detail = '') {
  if (P.ended) return;
  P.ended = true; P.endTime = 0; P.reason = reason;
  if (reason === 'crash') {
    spawnDebris(P.pos, P.vel, [plane.userData.paint, 0x2b2b2b, 0xd9bd8c]);
    plane.visible = false;
    Sound.thud(0.9, 0.9);
    P.vel.multiplyScalar(0);
    P.detail = detail;
  } else if (reason === 'splash') {
    // Тонет: брызги при ударе, дальше самолёт медленно уходит под воду носом вперёд
    const sp = P.vel.length();
    for (let i = 0; i < 16; i++) spawnPuff(P.pos.clone().add(new V3((Math.random() - 0.5) * 3, 0, (Math.random() - 0.5) * 3)), 0xe3f4ff, 0.9, 1.0, new V3((Math.random() - 0.5) * 5, 3 + Math.random() * Math.min(8, sp * 0.15), (Math.random() - 0.5) * 5));
    spawnRipple(P.pos);
    Sound.thud(0.4, 0.6);
    P.vel.set(P.vel.x * 0.15, 0, P.vel.z * 0.15);
    P.sinkT = 0;
  } else if (reason === 'landed') {
    P.landed = true;
  }
}

function finishResults() {
  mode = 'result';
  const dist = Math.floor(P.maxZ);
  const rows = [];
  rows.push(['Дистанция ' + dist + ' м', dist]);
  if (P.coins) rows.push([`Монеты и кольца${P.rings ? ` (колец: ${P.rings})` : ''}`, P.coins]);
  if (P.finished) rows.push(['🏁 Финиш!', 1500]);
  const total = rows.reduce((s, r) => s + r[1], 0);
  save.money += total;
  save.flights++;
  let rec = '';
  if (dist > save.best) { if (save.best > 0) rec = `Новый рекорд дальности! (было ${save.best} м)`; save.best = dist; }
  if (P.finished) { save.finishes++; rec = save.finishes === 1 ? 'Ты долетел до финиша! Ура! Попробуй ещё и собери все кольца.' : rec; }
  persist();

  const titles = { crash: 'Крушение!', splash: 'Буль-буль!', landed: 'Посадка', finish: 'ФИНИШ!', quit: 'Полёт завершён', out: 'Улетел за пределы' };
  const reasons = {
    crash: P.detail || 'Самолёт разбился',
    splash: 'Самолёт утонул в реке',
    landed: P.lastImpact < 2.5 && P.bounces === 0 ? 'Идеальная посадка!' : 'Самолёт остановился',
    finish: 'Ты пересёк финишную черту!',
    quit: 'Полёт прерван', out: 'Самолёт улетел за горы',
  };
  $('r-title').textContent = P.finished ? '🏁 ФИНИШ!' : titles[P.reason] || 'Полёт окончен';
  $('r-reason').textContent = reasons[P.reason] || '';
  $('r-table').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>+${b}</td></tr>`).join('') + `<tr class="total"><td>Итого</td><td><i class="coin"></i>${total}</td></tr>`;
  $('r-rec').textContent = rec;
  show('result');
  hide('hud');
}

// =====================================================================
//  Интерфейс
// =====================================================================

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function toast(text) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 1650);
}

function renderShop() {
  $('s-money').textContent = save.money;
  const cards = $('cards');
  cards.innerHTML = '';
  for (const key of UPG_ORDER) {
    const u = UPG[key], lv = save.lv[key], maxLv = u.costs.length;
    const locked = u.req && save.lv[u.req] === 0;
    const card = document.createElement('div');
    card.className = 'card' + (locked ? ' locked' : '');
    const cost = u.costs[lv];
    const pips = Array.from({ length: maxLv }, (_, i) => `<div class="pip ${i < lv ? 'on' : ''}"></div>`).join('');
    let btn;
    if (lv >= maxLv) btn = '<button class="buy max" disabled>МАКС</button>';
    else if (locked) btn = '<button class="buy" disabled>🔒</button>';
    else btn = `<button class="buy" data-k="${key}" ${save.money < cost ? 'disabled' : ''}><i class="coin"></i>${cost}</button>`;
    const next = lv < maxLv ? ` → <span style="color:#ffd76a">${u.levels[lv + 1]}</span>` : '';
    const desc = locked ? 'Топливо появится только после покупки двигателя (пропеллера).' : u.desc;
    card.innerHTML = `<div class="ico">${u.icon}</div><div class="name">${u.name}</div>${btn}<div class="lvl">${u.levels[lv]}${next}</div><div class="pips">${pips}</div><div class="desc">${desc}</div>`;
    cards.appendChild(card);
  }
  cards.querySelectorAll('button[data-k]').forEach((b) => b.addEventListener('click', () => buy(b.dataset.k)));
  renderStats();
}
function buy(key) {
  const u = UPG[key], lv = save.lv[key];
  if (lv >= u.costs.length || save.money < u.costs[lv]) return;
  if (u.req && save.lv[u.req] === 0) return;
  save.money -= u.costs[lv];
  save.lv[key]++;
  persist();
  Sound.init();
  Sound.blip(520, 0.15, 'square', 0.12); setTimeout(() => Sound.blip(780, 0.2, 'square', 0.1), 100);
  if (key === 'sling') buildSlingshot();
  rebuildPlane();
  placeOnSlingshot();
  renderShop();
  toast(`${UPG[key].name}: ${UPG[key].levels[save.lv[key]]}`);
}
function renderStats() {
  const s = computeStats(save.lv);
  const bar = (label, val, frac) => `<div class="stat"><div class="top"><span>${label}</span><b>${val}</b></div><div class="bar"><i style="width:${Math.round(clamp(frac, 0, 1) * 100)}%"></i></div></div>`;
  const glide = s.liftK > 0 ? (s.liftK * 0.5 / (s.cd0 + s.liftK * 0.09 * 0.25)).toFixed(1) : '—';
  $('stats').innerHTML =
    bar('Скорость запуска', Math.round(s.launch * 3.6) + ' км/ч', (s.launch - 20) / 54) +
    bar('Подъёмная сила', s.liftK > 0 ? 'качество ' + glide : 'нет', s.liftK / 0.036) +
    bar('Устойчивость', save.lv.tail ? ['хорошая', 'отличная', 'идеальная', 'идеальная'][tierOf(save.lv.tail)] : 'слабая', (save.lv.tail + 1) / 16) +
    bar('Управляемость', ['почти нет', 'слабая', 'средняя', 'хорошая', 'отличная', 'превосходная'][Math.round((save.lv.wings / 25 + save.lv.tail / 15) / 2 * 5)], (save.lv.wings / 25 + save.lv.tail / 15) / 2) +
    bar('Тяга', s.thrust > 0 ? s.thrust.toFixed(1) + ' м/с²' : 'нет двигателя', s.thrust / 15.4) +
    bar('Топливо', s.fuel > 0 ? s.fuel + ' с' : 'нет', s.fuel / 30) +
    bar('Сопротивление', (s.cd0 * 10000).toFixed(1), 1 - (s.cd0 - 0.0005) / 0.0008);
  $('records').innerHTML = `Рекорд: <b>${save.best} м</b> из ${FINISH_Z} · Полётов: <b>${save.flights}</b>${save.finishes ? ` · Финишей: <b>${save.finishes}</b>` : ''}`;
  $('opt-invert').checked = !!save.invert;
  document.querySelectorAll('#opt-quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === save.quality));
  $('opt-fps').checked = !!save.showFps;
  $('opt-sound').checked = !!save.sound;
}
function updateAimHud() {
  $('a-power').style.width = Math.round(aim.pull * 100) + '%';
  $('a-pitch').textContent = Math.round(aim.pitch) + '°';
  $('a-yaw').textContent = (aim.yaw > 0.5 ? '→' : aim.yaw < -0.5 ? '←' : '') + Math.abs(Math.round(aim.yaw)) + '°';
  $('a-speed').textContent = Math.round(S.launch * (0.25 + 0.75 * aim.pull) * 3.6);
  $('aim-hint').classList.toggle('hidden', aim.pull > 0.02 || drag.id !== null || aim.pulling);
}
let warnText = '';
function updateFlightHud() {
  const v = P.vel.length();
  $('h-speed').textContent = Math.round(v * 3.6) + ' км/ч';
  $('h-alt').textContent = Math.max(0, Math.round(P.pos.y - terrainH(P.pos.x, P.pos.z))) + ' м';
  $('h-dist').textContent = Math.floor(P.maxZ) + ' м';
  $('h-prog').style.width = clamp(P.maxZ / FINISH_Z, 0, 1) * 100 + '%';
  $('h-best').style.left = clamp(save.best / FINISH_Z, 0, 1) * 100 + '%';
  $('h-togo').textContent = P.maxZ < FINISH_Z ? `до финиша ${Math.ceil(FINISH_Z - P.maxZ)} м` : 'финиш!';
  if (S.thrust > 0) {
    $('h-fuel').style.width = (P.fuel / S.fuel * 100) + '%';
    $('h-fuel-label').innerHTML = P.fuel > 0 ? `⛽ ${P.fuel.toFixed(1)} с${isTouch ? '' : ' · <span class="kbd">Пробел</span>'}` : '⛽ пусто';
  }
  let w = '';
  if (P.pos.y > THIN_AIR) w = 'Разреженный воздух — крылья и мотор теряют силу';
  else if (Math.abs(P.pos.x) > VALLEY + 10) w = 'Осторожно, горы!';
  if (w !== warnText) { warnText = w; $('hud-warn').textContent = w; $('hud-warn').style.display = w ? 'block' : 'none'; }
}

$('go').addEventListener('click', () => enterAim());
$('r-ok').addEventListener('click', () => enterHangar());
$('opt-invert').addEventListener('change', (e) => { save.invert = e.target.checked; persist(); });
document.querySelectorAll('#opt-quality button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.q === save.quality) return;
  const needReload = (b.dataset.q === 'high') !== (save.quality === 'high');   // сглаживание включается только при перезагрузке
  save.quality = b.dataset.q; persist();
  if (needReload) location.reload(); else { applyQuality(); renderStats(); }
}));
$('open-settings').addEventListener('click', () => { renderStats(); show('settings'); });
$('set-close').addEventListener('click', () => hide('settings'));
// Секрет для создателя: 5 быстрых нажатий на заголовок «Настройки» открывают режим разработчика
let devTaps = 0, devTimer = 0;
$('set-title').addEventListener('click', () => {
  clearTimeout(devTimer);
  devTimer = setTimeout(() => { devTaps = 0; }, 1500);
  if (++devTaps >= 5) { devTaps = 0; save.dev = !save.dev; persist(); $('dev').classList.toggle('hidden', !save.dev); toast(save.dev ? 'Режим создателя включён' : 'Режим создателя выключен'); }
});
document.querySelectorAll('#dev [data-money]').forEach((b) => b.addEventListener('click', () => {
  save.money += +b.dataset.money; persist(); renderShop(); toast(`+${(+b.dataset.money).toLocaleString('ru-RU')}`);
}));
$('dev-max').addEventListener('click', () => {
  for (const k of UPG_ORDER) save.lv[k] = UPG[k].costs.length;
  persist(); buildSlingshot(); rebuildPlane(); placeOnSlingshot(); renderShop(); toast('Всё прокачано до максимума');
});
$('dev-zero').addEventListener('click', () => {
  for (const k of UPG_ORDER) save.lv[k] = 0;
  persist(); buildSlingshot(); rebuildPlane(); placeOnSlingshot(); renderShop(); toast('Прокачка обнулена');
});
$('dev').classList.toggle('hidden', !save.dev);
$('settings').addEventListener('click', (e) => { if (e.target.id === 'settings') hide('settings'); });
$('opt-fps').addEventListener('change', (e) => { save.showFps = e.target.checked; persist(); $('fps').style.display = save.showFps ? 'block' : 'none'; });
$('opt-sound').addEventListener('change', (e) => { save.sound = e.target.checked; persist(); Sound.setMuted(!save.sound); });
// Подтверждение вторым нажатием: в некоторых встроенных браузерах confirm() не работает
let resetArmed = 0;
$('reset').addEventListener('click', () => {
  const btn = $('reset');
  if (Date.now() - resetArmed > 4000) {
    resetArmed = Date.now();
    btn.textContent = 'Точно сбросить? Нажми ещё раз';
    setTimeout(() => { if (Date.now() - resetArmed >= 4000) btn.textContent = 'Сбросить прогресс'; }, 4100);
    return;
  }
  resetArmed = 0;
  btn.textContent = 'Сбросить прогресс';
  save = defaultSave(); persist(); enterHangar();
});

addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (mode === 'aim' && e.code === 'Space') aim.pulling = true;
  if (mode === 'aim' && e.code === 'Escape') enterHangar();
  if (mode === 'hangar' && insp.on && e.code === 'Escape') setInspect(false);
  if (mode === 'hangar' && e.code === 'Enter') enterAim();
  else if (mode === 'result' && (e.code === 'Enter' || e.code === 'Space')) enterHangar();
  if (mode === 'flight' && e.code === 'KeyR' && !P.ended && !paused) endFlight('quit');
  if (mode === 'flight' && (e.code === 'Escape' || e.code === 'KeyP') && !P.ended) setPaused(!paused);
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (mode === 'aim' && e.code === 'Space' && aim.pulling) { aim.pulling = false; launch(); }
});
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
// Натяжение как в Angry Birds: тянешь самолёт пальцем или мышью и отпускаешь.
// Вниз — сильнее и выше, вбок — поворот в противоположную сторону.
const drag = { id: null, x0: 0, y0: 0, pitch: 25, yaw: 0 };
function aimFromDrag(dx, dy) {
  const L = Math.min(innerWidth, innerHeight) * 0.38;
  aim.pull = clamp(Math.hypot(dx, dy) / L, 0, 1);
  const back = 0.35 + 0.6 * aim.pull;      // насколько резинка оттянута назад
  aim.pitch = clamp(Math.atan2(Math.max(0, dy) / L, back) * 180 / Math.PI, 2, MAX_AIM_PITCH);
  aim.yaw = clamp(Math.atan2(-dx / L * 0.5, back) * 180 / Math.PI, -30, 30);
}
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (mode !== 'aim' || drag.id !== null) return;
  Sound.init();
  drag.id = e.pointerId; drag.x0 = e.clientX; drag.y0 = e.clientY; drag.pitch = aim.pitch; drag.yaw = aim.yaw;
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (err) { /* синтетические события */ }
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (mode === 'aim' && e.pointerId === drag.id) aimFromDrag(e.clientX - drag.x0, e.clientY - drag.y0);
});
const endDrag = (e) => {
  if (e.pointerId !== drag.id) return;
  drag.id = null;
  if (mode !== 'aim') return;
  if (aim.pull > 0.08) launch();
  else { aim.pull = 0; aim.pitch = drag.pitch; aim.yaw = drag.yaw; }   // слишком слабо — отмена, угол возвращается
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
(function setupTouch() {
  const stick = $('stick'), knob = $('knob'), btn = $('tbtn');
  let sid = null;
  const moveStick = (e) => {
    const r = stick.getBoundingClientRect(), R = r.width / 2;
    let dx = (e.clientX - r.left - R) / R, dy = (e.clientY - r.top - R) / R;
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    touch.x = Math.abs(dx) < 0.12 ? 0 : dx; touch.y = Math.abs(dy) < 0.12 ? 0 : dy;
    knob.style.transform = `translate(${dx * R * 0.6}px, ${dy * R * 0.6}px)`;
  };
  const endStick = () => { sid = null; touch.x = touch.y = 0; knob.style.transform = ''; };
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch (err) { /* синтетические события */ } };
  stick.addEventListener('pointerdown', (e) => { e.preventDefault(); sid = e.pointerId; capture(stick, sid); moveStick(e); });
  stick.addEventListener('pointermove', (e) => { if (e.pointerId === sid) moveStick(e); });
  stick.addEventListener('pointerup', endStick);
  stick.addEventListener('pointercancel', endStick);
  // Мотор — переключатель: нажал — включился, нажал ещё раз — выключился (удобно одной рукой)
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    Sound.init();
    if (P.fuel > 0) touch.btn = !touch.btn;
  });
  $('tfull').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); await screen.orientation?.lock?.('landscape'); }
      else await document.exitFullscreen();
    } catch (err) { /* не все браузеры умеют */ }
  });
})();
function updateTouchUi() {
  // Джойстик и кнопки появляются только после пуска, чтобы не мешать натяжению
  const show = isTouch && mode === 'flight' && !P.ended && !paused;
  $('pause-btn').classList.toggle('hidden', !(mode === 'flight' && !P.ended && !paused));
  $('touch').classList.toggle('hidden', !show);
  $('tbtn').classList.toggle('hidden', !(S.thrust > 0));
  if (!(P.fuel > 0)) touch.btn = false;
  if (!show) { touch.x = touch.y = 0; touch.btn = false; }
  $('tbtn').classList.toggle('dim', !(P.fuel > 0));
  $('tbtn').classList.toggle('on', touch.btn);
  const label = P.fuel > 0 ? `${touch.btn ? 'Мотор ВКЛ' : 'Мотор'}<small>${P.fuel.toFixed(1)} с</small>` : 'Пусто';
  if ($('tbtn').innerHTML !== label) $('tbtn').innerHTML = label;
}

// =====================================================================
//  Камера
// =====================================================================

const camLook = new V3(), camPos = new V3(), camHeading = new V3(0, 0, 1);
let orbit = 0;
function updateCamera(dt) {
  if (mode === 'hangar' && insp.on) {
    // Осмотр: самолёт заряжен в рогатку; камера на сфере вокруг них, пользователь крутит её пальцем/мышью
    const c = _vd.copy(plane.position).lerp(_vb.set(0, launchBase.y + 0.5, 1.8), 0.35);
    const cp = Math.cos(insp.pitch);
    const target = _tmp.set(c.x + Math.sin(insp.yaw) * cp * insp.dist, c.y + Math.sin(insp.pitch) * insp.dist, c.z + Math.cos(insp.yaw) * cp * insp.dist);
    target.y = Math.max(target.y, terrainH(target.x, target.z) + 0.5);
    camPos.lerp(target, 1 - Math.exp(-dt * 10));
    camLook.lerp(c, 1 - Math.exp(-dt * 10));
  } else if (mode === 'hangar') {
    orbit += dt * 0.18;
    const c = launchBase;
    const a = Math.PI * 0.72 + Math.sin(orbit) * 0.55;
    const target = _tmp.set(c.x + Math.sin(a) * 9, c.y + 2.6, c.z + Math.cos(a) * 9);
    camPos.lerp(target, 1 - Math.exp(-dt * 3));
    camLook.lerp(_tmp2.set(c.x - 2.4, c.y + 0.2, c.z + 0.5), 1 - Math.exp(-dt * 3));
  } else if (mode === 'aim') {
    // Камера смотрит по курсу прицела, а не по углу вверх — иначе при натяжении она уезжает в небо
    const yaw = -aim.yaw * Math.PI / 180;
    _f.set(Math.sin(yaw), 0, Math.cos(yaw));
    // Камера дальше и смотрит чуть вниз, чтобы рогатка была в нижней трети кадра, а не обрезалась краем
    const portrait = camera.aspect < 1;
    // При натяжении камера чуть отъезжает, чтобы оттянутый самолёт оставался в кадре
    const target = _tmp.copy(launchBase).addScaledVector(_f, (portrait ? -27 : -21) - aim.pull * 4).add(_tmp2.set(0, portrait ? 7.5 : 6.5, 0));
    camPos.lerp(target, 1 - Math.exp(-dt * 6));
    camLook.lerp(_tmp2.copy(launchBase).addScaledVector(_f, portrait ? 12 : 18).add(_vb.set(0, (portrait ? 6 : 4) + aim.pitch * 0.08 - aim.pull * 3, 0)), 1 - Math.exp(-dt * 6));
  } else {
    _f.set(0, 0, 1).applyQuaternion(P.q);
    const v = P.vel.length();
    const look = _tmp2.copy(_f);
    if (v > 3) { _vd.copy(P.vel).divideScalar(v); look.lerp(_vd, save.lv.tail > 0 ? 0.4 : 0.8); }
    if (look.lengthSq() < 1e-4) look.set(0, 0, 1);
    look.normalize();
    // Камера держит курс почти горизонтально и наклоняется лишь на треть угла полёта:
    // при наборе высоты в кадре остаются земля и горизонт, а не одно небо
    const hl = Math.hypot(look.x, look.z);
    if (hl > 0.15) camHeading.set(look.x / hl, 0, look.z / hl);
    const camPitch = clamp(Math.asin(clamp(look.y, -1, 1)) * 0.35, -0.3, 0.22);
    look.copy(camHeading).multiplyScalar(Math.cos(camPitch)).add(_vb.set(0, Math.sin(camPitch), 0));
    const dist = P.ended ? 16 : 9.5 + v * 0.03;
    const target = _tmp.copy(P.pos).addScaledVector(look, -dist).add(_vb.set(0, P.ended ? 6 : 2.8, 0));
    const gh = terrainH(target.x, target.z) + 1.5;
    if (target.y < gh) target.y = gh;
    camPos.lerp(target, 1 - Math.exp(-dt * (P.ended ? 2 : 6)));
    camLook.lerp(_vb.copy(P.pos).addScaledVector(look, P.ended ? 0 : 6).add(_tmp.set(0, 0.8, 0)), 1 - Math.exp(-dt * 10));
    const fov = 62 + clamp((v - 25) * 0.18, 0, 14);
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
  }
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  sky.position.copy(camera.position);
  const focus = mode === 'flight' ? P.pos : launchBase;
  sun.position.copy(focus).add(SUN_OFFSET);
  sun.target.position.copy(focus);
}

// =====================================================================
//  Качество графики и счётчик FPS
// =====================================================================

const QUALITY = {
  high: { scale: Math.min(devicePixelRatio, 2), shadow: 2048, soft: true, tufts: true, far: 1500 },
  medium: { scale: Math.min(devicePixelRatio, 1.25), shadow: 1024, soft: false, tufts: true, far: 1300 },
  low: { scale: 0.75, shadow: 0, soft: false, tufts: false, far: 1000 },
};
let renderScale = 1;
function applyQuality() {
  const q = QUALITY[save.quality] || QUALITY.medium;
  renderScale = q.scale;
  renderer.setPixelRatio(renderScale);
  renderer.shadowMap.enabled = q.shadow > 0;
  renderer.shadowMap.type = q.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  sun.castShadow = q.shadow > 0;
  if (q.shadow && sun.shadow.mapSize.x !== q.shadow) {
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  const tufts = scene.getObjectByName('tufts'); if (tufts) tufts.visible = q.tufts;
  camera.far = q.far; camera.updateProjectionMatrix();
  scene.fog.far = q.far - 200;
  scene.traverse((o) => { if (o.material && !Array.isArray(o.material)) o.material.needsUpdate = true; });
}
const fpsMeter = { frames: 0, time: 0, fps: 60 };
function updateFps(dt) {
  fpsMeter.frames++; fpsMeter.time += dt;
  if (fpsMeter.time < 1) return;
  fpsMeter.fps = fpsMeter.frames / fpsMeter.time;
  fpsMeter.frames = 0; fpsMeter.time = 0;
  const el = $('fps');
  el.style.display = save.showFps ? 'block' : 'none';
  el.textContent = `${Math.round(fpsMeter.fps)} FPS · ${Math.round(renderScale * 100)}%`;
}

// =====================================================================
//  Главный цикл
// =====================================================================

let last = performance.now(), simTime = 0, puffTimer = 0;
let paused = false;
function setPaused(on) {
  if (on && (mode !== 'flight' || P.ended)) return;
  paused = on;
  $('pause').classList.toggle('hidden', !on);
  for (const k in keys) keys[k] = false;
  touch.x = touch.y = 0;
  if (on) Sound.update(0, false);
}
$('pause-btn').addEventListener('click', () => setPaused(true));
$('p-resume').addEventListener('click', () => setPaused(false));
$('p-end').addEventListener('click', () => { setPaused(false); if (mode === 'flight' && !P.ended) endFlight('quit'); });
$('p-hangar').addEventListener('click', () => { setPaused(false); enterHangar(); });
addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
const STEP = 1 / 120;
let acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  // На паузе время стоит: физика, препятствия и частицы замирают, кадр просто перерисовывается
  const dt = paused ? 0 : Math.min(0.05, (now - last) / 1000);
  last = now;
  simTime += dt;
  updateFps(dt);
  updateTouchUi();

  for (const m of movers) m.update(simTime, dt);
  animateSlingshot(simTime);
  updateCoins(simTime, dt);

  if (mode === 'aim') {
    const rate = 32;
    if (keys.KeyW || keys.ArrowUp) aim.pitch = clamp(aim.pitch + rate * dt, 2, MAX_AIM_PITCH);
    if (keys.KeyS || keys.ArrowDown) aim.pitch = clamp(aim.pitch - rate * dt, 2, MAX_AIM_PITCH);
    if (keys.KeyD || keys.ArrowRight) aim.yaw = clamp(aim.yaw + rate * dt, -30, 30);
    if (keys.KeyA || keys.ArrowLeft) aim.yaw = clamp(aim.yaw - rate * dt, -30, 30);
    if (aim.pulling) aim.pull = Math.min(1, aim.pull + dt / 1.1);
    placeOnSlingshot();
    updateTrajectory();
    updateAimHud();
  } else if (mode === 'flight') {
    if (!P.ended) {
      const inp = input();
      acc += dt;
      while (acc >= STEP && !P.ended) {
        physicsStep(STEP, inp);
        P.time += STEP;
        P.maxZ = Math.max(P.maxZ, P.pos.z);
        if (!P.ended && checkCollisions()) endFlight('crash', 'Столкновение с препятствием');
        if (!P.ended && P.pos.z >= FINISH_Z && !P.finished) { P.finished = true; Sound.blip(523, 0.2); setTimeout(() => Sound.blip(659, 0.2), 150); setTimeout(() => Sound.blip(784, 0.4), 300); endFlight('finish'); }
        if (!P.ended && (P.pos.z < -150 || Math.abs(P.pos.x) > 300)) endFlight('out');
        acc -= STEP;
      }
      if (!P.ended) collectStuff();
      plane.position.copy(P.pos);
      plane.quaternion.copy(P.q);
      animateEngines(dt, P.throttle ? 60 : Math.min(25, P.vel.length() * 0.5), P.throttle);
      if (P.throttle) {
        puffTimer += dt;
        if (puffTimer > 0.05) { puffTimer = 0; _f.set(0, 0, 1).applyQuaternion(P.q); spawnPuff(_tmp.copy(P.pos).addScaledVector(_f, -1.6).add(_vb.set(0, -0.3, 0)), 0xffffff, 0.3, 0.55, _vb.copy(P.vel).multiplyScalar(0.55)); }
      }
      Sound.update(P.vel.length(), P.throttle);
      updateFlightHud();
    } else {
      P.endTime += dt;
      if (P.reason === 'finish') P.pos.addScaledVector(P.vel, dt);
      if (P.reason === 'splash') updateSinking(dt);
      plane.position.copy(P.pos);
      plane.quaternion.copy(P.q);
      Sound.update(0, false);
      if (P.endTime > (P.reason === 'landed' ? 0.8 : P.reason === 'splash' ? 3.2 : 1.8)) finishResults();
    }
    relaxBands(dt);
  } else if (mode === 'hangar' || mode === 'result') {
    animateEngines(dt, 1.5, false);
    if (mode === 'result') relaxBands(dt);
  }

  updateParticles(dt);
  updateRipples(dt);
  updateSparks(dt);
  updateCamera(dt);
  renderer.render(scene, camera);
}

// =====================================================================
//  Старт
// =====================================================================

buildTerrain();
generateWorld();
mergeStatic(statics);
mergeStatic(cloudRoot, 600);
applyQuality();
enterHangar();
camPos.set(8, launchBase.y + 3, -8);
camLook.copy(launchBase);
hide('loading');
requestAnimationFrame(frame);

// Для отладки из консоли
window.__game = { get sling() { return slingGroup; }, spawnSparks, coins, obstacles, collectStuff, rings, furrows, renderer, scene, camera, THREE, physicsStep, checkCollisions, setLevels: (lv) => { Object.assign(save.lv, lv); buildSlingshot(); rebuildPlane(); }, buildPlaneMesh, P, save, S: () => S, keys, terrainH, enterAim, launch, aim, get mode() { return mode; } };
