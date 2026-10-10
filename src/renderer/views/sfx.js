'use strict';
/**
 * sfx.js — 微交互音效（U27）：WebAudio 合成轻音效（零资源文件）
 *
 * 三枚合成音（振荡器 + 增益包络，单枚总时长 ≤0.3s）：
 * - toggle：开关切换（短促上滑单音）
 * - save：收藏成功（三度上行双音）
 * - done：挑战完成（主三和弦琶音）
 *
 * 能力不可达静默（voice-orb 同款）：AudioContext 缺失 / 构造即抛 → 本会话标记
 * dead，play() 恒 false 且绝不抛错；上下文被自动播放策略挂起 → 当次静默跳过
 * （不判死，恢复后可播）。设置开关默认关（RobinRead.sfx.enabled，设置→通用
 * 「音效」）；app.js initSfx 注入 enabled()，各视图 import { playSfx } 直呼——
 * 未初始化时静默 no-op，零接线负担。
 *
 * 注入缝（探针离线化）：window.__robinSfxBridge = { Ctor } 整体接管 AudioContext
 * 构造；实例经 window.__robinSfx 观测（played() / capability()）。
 */

/** U27 三枚音的名字表（探针/设置页共用）。 */
export const SFX_NAMES = ['toggle', 'save', 'done'];

/** 单枚音的时长硬上限（秒）：轻音效纪律，超了就是 bug。 */
export const SFX_MAX_DUR = 0.3;

/**
 * 音色计划（纯函数，探针可直接断言包络合同）。
 * 每音色：at 起始秒 / freq Hz / [endFreq 滑音终值] / dur 秒 / gain 峰值 / type 波形。
 * 总时长（max(at+dur)）≤ SFX_MAX_DUR。
 */
export function sfxPlan(name) {
  switch (name) {
    case 'toggle':
      return [{ at: 0, freq: 660, endFreq: 880, dur: 0.09, gain: 0.05, type: 'sine' }];
    case 'save':
      return [
        { at: 0, freq: 523.25, dur: 0.11, gain: 0.06, type: 'triangle' },
        { at: 0.09, freq: 659.25, dur: 0.13, gain: 0.06, type: 'triangle' },
      ];
    case 'done':
      return [
        { at: 0, freq: 523.25, dur: 0.12, gain: 0.05, type: 'sine' },
        { at: 0.08, freq: 659.25, dur: 0.12, gain: 0.05, type: 'sine' },
        { at: 0.16, freq: 783.99, dur: 0.14, gain: 0.05, type: 'sine' },
      ];
    default:
      return null;
  }
}

/** AudioContext 构造器（注入缝优先：显式 Ctor 键整体接管——含 null=无能力；探针 mock 两路）。 */
function audioContextCtor() {
  const bridge = typeof window !== 'undefined' ? window.__robinSfxBridge : null;
  if (bridge && Object.prototype.hasOwnProperty.call(bridge, 'Ctor')) return bridge.Ctor;
  if (typeof window === 'undefined') return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

let shared = null;

/**
 * 初始化共享实例（app.js 启动时一次）：deps.enabled() 为设置开关
 * （sfxEnabled，默认关）。挂 window.__robinSfx 供探针观测。
 */
export function initSfx(deps = {}) {
  shared = createSfx(deps);
  if (typeof window !== 'undefined') window.__robinSfx = shared; // E2E 探测句柄
  return shared;
}

/** 共享实例未初始化（视图先于 app 调用）→ 静默 no-op。 */
export function playSfx(name) {
  return shared ? shared.play(name) : false;
}

export function createSfx(deps = {}) {
  const enabled = deps.enabled || (() => false);
  let ctx = null;
  let dead = false;
  const log = [];
  return {
    /** 播一枚合成音。被关/未知名/能力不可达 → false（静默），成功调度 → true。 */
    play(name) {
      const plan = sfxPlan(name);
      if (!plan || dead || enabled() !== true) return false;
      const Ctor = audioContextCtor();
      if (!Ctor) { dead = true; return false; }
      if (!ctx) {
        try { ctx = new Ctor(); } catch (_) { dead = true; return false; }
      }
      if (!ctx || typeof ctx.currentTime !== 'number' || typeof ctx.createOscillator !== 'function') {
        dead = true; // 形状不对的构造产物：本会话不再尝试
        return false;
      }
      if (ctx.state === 'suspended') {
        try { ctx.resume?.(); } catch (_) { /* resume 失败按下判定 */ }
        if (ctx.state === 'suspended') return false; // 自动播放策略挂起：当次静默（不判死）
      }
      const t0 = ctx.currentTime + 0.01;
      try {
        for (const tone of plan) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = tone.type || 'sine';
          osc.frequency.setValueAtTime(tone.freq, t0 + tone.at);
          if (tone.endFreq) osc.frequency.linearRampToValueAtTime(tone.endFreq, t0 + tone.at + tone.dur);
          // 增益包络：静音快起（≤20ms 攻击防爆音）→ 指数回落静音
          gain.gain.setValueAtTime(0.0001, t0 + tone.at);
          gain.gain.exponentialRampToValueAtTime(tone.gain, t0 + tone.at + Math.min(0.02, tone.dur / 3));
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.at + tone.dur);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0 + tone.at);
          osc.stop(t0 + tone.at + tone.dur + 0.02);
        }
      } catch (_) { return false; }
      log.push(name);
      if (log.length > 50) log.shift();
      return true;
    },
    /** 探测句柄：本会话已播放序列（cap 50，先到先出）。 */
    played: () => log.slice(),
    /** 能力态：'ready'（可播）| 'dead'（本会话判死）| 'missing'（无 AudioContext）。 */
    capability() {
      if (dead) return 'dead';
      return audioContextCtor() ? 'ready' : 'missing';
    },
    /** 关闭开关即静默（enabled()=false）；上下文留给下次开启复用。 */
    dispose() { try { ctx?.close?.(); } catch (_) { /* 已关闭 */ } ctx = null; },
  };
}
