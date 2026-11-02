// 動画の通り道。決めた点を、なめらかな曲線でつないで歩く（下見と動画の書き出しで同じ動きにする）

import * as THREE from 'three';
import type { WalkPoint } from './types';

const MM = 0.001;
/** 向きを変える速さ（度/秒）。向きだけ変える点や急に曲がる点は、そのぶん時間をかける */
const TURN_SPEED = 30;
/** 歩き始めと止まるときに加速・減速する時間（秒） */
const RAMP = 1;

export interface PathPose {
  /** m（3D の座標） */
  x: number;
  y: number;
  z: number;
  /** ラジアン */
  yaw: number;
  pitch: number;
}

export interface PathTimeline {
  /** 全体の長さ（秒） */
  duration: number;
  at(sec: number): PathPose;
}

/** 点が 2 つ以上あるときの動き。speed は歩く速さ（m/秒） */
export function pathTimeline(points: WalkPoint[], speed: number): PathTimeline | null {
  if (points.length < 2) return null;
  // 向きは近い方へ回るように、度の差を積み重ねる（+179° → −179° を 2° の回転にする）
  const yaws: number[] = [points[0].yaw];
  for (let i = 1; i < points.length; i++) {
    const d = ((((points[i].yaw - points[i - 1].yaw) % 360) + 540) % 360) - 180;
    yaws.push(yaws[i - 1] + d);
  }
  const place = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p.x * MM, p.eye * MM, p.y * MM)), false, 'centripetal');
  const look = new THREE.CatmullRomCurve3(points.map((p, i) => new THREE.Vector3(yaws[i], p.pitch, 0)), false, 'catmullrom', 0.5);
  // 点から点までの時間
  const times: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y, b.eye - a.eye) * MM;
    const turn = Math.max(Math.abs(yaws[i] - yaws[i - 1]), Math.abs(b.pitch - a.pitch));
    times.push(Math.max(dist / Math.max(speed, 0.05), turn / TURN_SPEED, 0.2));
  }
  const moving = times.reduce((s, t) => s + t, 0);
  const ramp = Math.min(RAMP, moving);
  const duration = moving + ramp;
  // 速さは台形（加速 → 一定 → 減速）。0〜1 の進み具合にする
  const progress = (t: number) => {
    const s = THREE.MathUtils.clamp(t, 0, duration);
    if (s < ramp) return (s * s) / (2 * ramp) / moving;
    if (s > duration - ramp) return 1 - ((duration - s) * (duration - s)) / (2 * ramp) / moving;
    return (s - ramp / 2) / moving;
  };
  const place3 = new THREE.Vector3();
  const look3 = new THREE.Vector3();
  return {
    duration,
    at(sec) {
      let left = progress(sec) * moving;
      let i = 0;
      while (i < times.length - 1 && left > times[i]) left -= times[i++];
      const u = (i + Math.min(left / times[i], 1)) / times.length;
      place.getPoint(u, place3);
      look.getPoint(u, look3);
      return { x: place3.x, y: place3.y, z: place3.z, yaw: THREE.MathUtils.degToRad(look3.x), pitch: THREE.MathUtils.degToRad(look3.y) };
    },
  };
}
