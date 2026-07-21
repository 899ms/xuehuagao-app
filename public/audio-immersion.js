// ============================================================
// 雪花膏 Audio Immersion System — 前端沉浸音频模块
// ============================================================
// 使用方式：
// 1. 将 8 个音频文件放入项目的 /audio/ 目录
// 2. 在 HTML 中通过 <script src="/audio-immersion.js"></script> 引入（置于 </body> 前）
// 3. 无需其他改动 —— 模块会自动接管 setScene / send / typewrite 钩子
//
// /audio/ 目录所需文件：
//   opening_enter.mp3       — 开屏音 (1.5s)
//   ui_message_send.wav     — 发送消息音
//   ui_message_receive.wav  — 接收消息音
//   scene_switch_soft.wav   — 场景转场音
//   normal_room_loop.mp3    — 日常环境音 (loop)
//   cafe_ambient_loop.mp3   — 咖啡馆环境音 (loop)
//   rainy_window_loop.mp3   — 雨天环境音 (loop)
//   thinking_night_loop.mp3 — 深夜环境音 (loop)
//
// 公开 API（window.AudioImmersion，向后兼容）：
//   unlock()                 — 首次用户手势时自动调用，也可手动调用
//   play(name)               — 播放一次性音效（opening/send/receive/switch）
//   switchScene(sceneKey)    — 切换场景环境音（300~800ms 交叉淡入淡出）
//   msgSend() / msgReceive() — 消息音效便捷方法
//   setVolume(group, value)  — 设置音量，group: 'master' | 'ambient' | 'sfx'，value: 0~1
//   getVolume(group)         — 读取音量（省略 group 返回全部分组）
//   toggleMute() / setMuted(bool) / isMuted()
//   音量与静音状态持久化于 localStorage。
// ============================================================

(function () {
  'use strict';

  // ── 1. 配置 ────────────────────────────────────────────────

  var AUDIO_FILES = {
    opening:  '/audio/opening_enter.mp3',
    send:     '/audio/ui_message_send.wav',
    receive:  '/audio/ui_message_receive.wav',
    switch:   '/audio/scene_switch_soft.wav',
    normal:   '/audio/normal_room_loop.mp3',
    cafe:     '/audio/cafe_ambient_loop.mp3',
    rainy:    '/audio/rainy_window_loop.mp3',
    thinking: '/audio/thinking_night_loop.mp3',
  };

  // 各音效的基础音量（在分组音量之前叠加）
  var BASE_VOL = {
    opening: 0.35,
    ambient: 0.12,   // 环境音：极轻，不打扰对话
    switch:  0.10,   // 转场音：几乎无感
    send:    0.15,   // 发送消息
    receive: 0.13,   // 接收消息
  };

  // 一次性音效（非循环）清单
  var ONE_SHOTS = { opening: true, send: true, receive: true, switch: true };

  // 场景名 → 环境音 key
  var SCENE_AUDIO_MAP = {
    normal:   'normal',
    cafe:     'cafe',
    rainy:    'rainy',
    thinking: 'thinking',
  };

  // 交叉淡入淡出时长（秒），均在 300ms~800ms 区间内
  var FADE_OUT_SEC = 0.35;  // 旧场景淡出 350ms
  var FADE_IN_SEC  = 0.50;  // 新场景淡入 500ms

  var STORAGE_KEYS = {
    volumes: 'xuehuagao.audio.volumes',
    muted:   'xuehuagao.audio.muted',
  };

  var LOG_PREFIX = '[XuehuagaoAudio]';

  var ICON_SOUND_ON  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
  var ICON_SOUND_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';

  // ── 2. localStorage 安全读写（隐私模式下降级为内存态）───────

  var storage = {
    read: function (key) {
      try { return window.localStorage.getItem(key); } catch (e) { return null; }
    },
    write: function (key, value) {
      try { window.localStorage.setItem(key, value); } catch (e) { /* 静默忽略 */ }
    },
  };

  function loadPersistedVolumes() {
    var defaults = { master: 1, ambient: 1, sfx: 1 };
    try {
      var raw = storage.read(STORAGE_KEYS.volumes);
      if (!raw) return defaults;
      var parsed = JSON.parse(raw);
      return {
        master:  clamp01(typeof parsed.master  === 'number' ? parsed.master  : 1),
        ambient: clamp01(typeof parsed.ambient === 'number' ? parsed.ambient : 1),
        sfx:     clamp01(typeof parsed.sfx     === 'number' ? parsed.sfx     : 1),
      };
    } catch (e) {
      return defaults;
    }
  }

  function loadPersistedMuted() {
    return storage.read(STORAGE_KEYS.muted) === '1';
  }

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  // ── 3. AudioManager（Web Audio API）─────────────────────────

  var AM = {
    // 节点与状态
    ctx: null,
    masterGain: null,   // 主音量 + 静音
    ambientGain: null,  // 环境音分组音量
    sfxGain: null,      // 音效分组音量
    buffers: {},        // key -> AudioBuffer（加载失败则缺省）
    loadFailed: {},     // key -> true（重试一次后仍失败）

    // 播放状态
    currentAmbient: null,   // 当前环境音轨道 { key, source, gain }，全局至多一条
    pendingQueue: [],       // 解锁前排队的一次性播放请求
    wantedScene: null,      // 解锁前记录的目标场景环境音

    // 用户与偏好状态
    unlocked: false,            // 是否已在用户手势中解锁音频上下文
    curtainOpened: false,       // 用户是否已点击「推开那扇窗」
    muted: loadPersistedMuted(),
    volumes: loadPersistedVolumes(),

    initStarted: false,

    // 初始化：创建音频上下文、加载全部音频（失败静默降级）
    init: function () {
      if (this.initStarted) return;
      this.initStarted = true;

      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) {
          console.warn(LOG_PREFIX, '当前浏览器不支持 Web Audio API，音频功能已禁用');
          return;
        }

        this.ctx = new AC();

        // 增益链：source -> perGain -> groupGain -> masterGain -> destination
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = this.muted ? 0 : this.volumes.master;
        this.masterGain.connect(this.ctx.destination);

        this.ambientGain = this.ctx.createGain();
        this.ambientGain.gain.value = this.volumes.ambient;
        this.ambientGain.connect(this.masterGain);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = this.volumes.sfx;
        this.sfxGain.connect(this.masterGain);
      } catch (e) {
        console.warn(LOG_PREFIX, '音频上下文初始化失败，音频功能已禁用:', e && e.message);
        this.ctx = null;
        return;
      }

      // 并发加载全部音频；单个失败不影响其余
      var self = this;
      var jobs = Object.keys(AUDIO_FILES).map(function (key) {
        return self.loadBuffer(key, AUDIO_FILES[key], true);
      });
      Promise.all(jobs).then(function () {
        var failed = Object.keys(self.loadFailed);
        if (failed.length) {
          console.warn(LOG_PREFIX, '以下音频加载失败（已静默降级）:', failed.join(', '));
        }
        // 若加载完成时已解锁，补播排队请求
        self.flushPending();
      });
    },

    // 加载并解码单个音频；allowRetry 为 true 时失败自动重试一次
    loadBuffer: function (key, url, allowRetry) {
      var self = this;
      return fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (arrBuf) { return self.ctx.decodeAudioData(arrBuf); })
        .then(function (buffer) {
          self.buffers[key] = buffer;
        })
        .catch(function (e) {
          if (allowRetry) {
            console.warn(LOG_PREFIX, '加载失败，500ms 后重试一次:', url, e && e.message);
            return new Promise(function (resolve) {
              setTimeout(function () {
                self.loadBuffer(key, url, false).then(resolve);
              }, 500);
            });
          }
          self.loadFailed[key] = true;
          console.warn(LOG_PREFIX, '重试仍失败，该音频已跳过:', url);
        });
    },

    // 首次用户手势：可靠解锁音频上下文，并补播排队请求
    unlock: function () {
      if (!this.ctx) return;

      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(function () { /* 静默忽略，下次手势再试 */ });
      }

      if (this.unlocked) return;
      this.unlocked = true;
      this.flushPending();
    },

    // 解锁且加载完成后，补播队列中的一次性音效与场景环境音
    flushPending: function () {
      if (!this.unlocked || !this.ctx) return;

      // 补播一次性音效（最多保留最近 10 条，防止刷屏）
      var queue = this.pendingQueue.splice(0, this.pendingQueue.length);
      for (var i = 0; i < queue.length; i++) {
        this.playNow(queue[i]);
      }

      // 补播场景环境音：仅在开屏已点过之后启动，与原有行为一致
      if (this.curtainOpened && this.wantedScene && !this.currentAmbient) {
        this.startAmbient(this.wantedScene);
      }
    },

    // 播放一次性音效；未解锁或尚未加载时入队，解锁后补播
    play: function (name) {
      if (!this.ctx) return;
      if (!this.unlocked || !this.buffers[name]) {
        if (ONE_SHOTS[name] && !this.loadFailed[name] && this.pendingQueue.length < 10) {
          // 同名音效只保留一条排队，避免解锁后连放
          if (this.pendingQueue.indexOf(name) === -1) this.pendingQueue.push(name);
        }
        return;
      }
      this.playNow(name);
    },

    // 实际播放（内部方法，假定已解锁）
    playNow: function (name) {
      if (!this.ctx || !this.sfxGain) return;
      var buffer = this.buffers[name];
      if (!buffer) return; // 加载失败：静默降级

      try {
        var source = this.ctx.createBufferSource();
        source.buffer = buffer;

        var gain = this.ctx.createGain();
        gain.gain.value = BASE_VOL[name] != null ? BASE_VOL[name] : 0.15;

        source.connect(gain);
        gain.connect(this.sfxGain);
        source.start();

        // 播放结束后释放节点，防泄漏
        source.onended = function () {
          try { source.disconnect(); } catch (e) {}
          try { gain.disconnect(); } catch (e) {}
        };
      } catch (e) {
        console.warn(LOG_PREFIX, '播放失败（已忽略）:', name, e && e.message);
      }
    },

    // 启动指定场景的环境音循环（带淡入）
    startAmbient: function (sceneKey) {
      if (!this.ctx || !this.ambientGain) return;
      if (this.currentAmbient && this.currentAmbient.key === sceneKey) return; // 已在播放
      var buffer = this.buffers[sceneKey];
      if (!buffer) return; // 加载失败：静默降级

      try {
        var gain = this.ctx.createGain();
        gain.gain.value = 0; // 从无声开始
        gain.connect(this.ambientGain);

        var source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(gain);
        source.start();

        // 淡入（500ms）
        var now = this.ctx.currentTime;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(BASE_VOL.ambient, now + FADE_IN_SEC);

        this.currentAmbient = { key: sceneKey, source: source, gain: gain };
      } catch (e) {
        console.warn(LOG_PREFIX, '环境音启动失败（已忽略）:', sceneKey, e && e.message);
      }
    },

    // 淡出并可靠停止一条环境音轨道
    stopTrack: function (track, fadeSec) {
      if (!track || !this.ctx) return;

      var source = track.source;
      var gain = track.gain;
      var now = this.ctx.currentTime;

      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      } catch (e) { /* 节点可能已断开，忽略 */ }

      // 淡出结束后停止并断开节点，避免叠音/泄漏
      setTimeout(function () {
        try { source.stop(); } catch (e) {}
        try { source.disconnect(); } catch (e) {}
        try { gain.disconnect(); } catch (e) {}
      }, fadeSec * 1000 + 80);
    },

    // 场景切换：旧环境音淡出 350ms + 转场音效 + 新环境音淡入 500ms
    switchScene: function (toSceneKey) {
      this.wantedScene = toSceneKey;
      if (!this.ctx || !this.unlocked || !this.curtainOpened) return;

      // 同场景：无需切换，直接返回（避免重复启动同一循环造成叠音）
      if (this.currentAmbient && this.currentAmbient.key === toSceneKey) return;

      // 停掉当前场景的旧轨道（全局至多一条），杜绝叠音/泄漏
      if (this.currentAmbient) {
        this.stopTrack(this.currentAmbient, FADE_OUT_SEC);
        this.currentAmbient = null;
      }

      this.play('switch');
      this.startAmbient(toSceneKey);
    },

    // ── 音量 API（持久化到 localStorage）────────────────────

    // group: 'master' | 'ambient' | 'sfx'；value: 0~1
    setVolume: function (group, value) {
      if (group !== 'master' && group !== 'ambient' && group !== 'sfx') return;
      value = clamp01(Number(value) || 0);
      this.volumes[group] = value;

      if (this.ctx) {
        var node = group === 'master' ? this.masterGain
                 : group === 'ambient' ? this.ambientGain
                 : this.sfxGain;
        if (node) {
          // 主音量在静音时保持 0，仅更新偏好值
          var target = (group === 'master' && this.muted) ? 0 : value;
          node.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
        }
      }

      storage.write(STORAGE_KEYS.volumes, JSON.stringify(this.volumes));
    },

    // 省略 group 时返回 { master, ambient, sfx } 副本
    getVolume: function (group) {
      if (group === 'master' || group === 'ambient' || group === 'sfx') {
        return this.volumes[group];
      }
      return { master: this.volumes.master, ambient: this.volumes.ambient, sfx: this.volumes.sfx };
    },

    // ── 静音 ────────────────────────────────────────────────

    setMuted: function (muted) {
      this.muted = !!muted;
      storage.write(STORAGE_KEYS.muted, this.muted ? '1' : '0');

      if (this.ctx && this.masterGain) {
        var now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, now, 0.05);
      }

      updateMuteButton(this.muted);
      return this.muted;
    },

    toggleMute: function () {
      return this.setMuted(!this.muted);
    },

    isMuted: function () {
      return this.muted;
    },

    // ── 消息音效便捷方法 ────────────────────────────────────

    msgSend: function ()    { this.play('send'); },
    msgReceive: function () { this.play('receive'); },
  };

  // ── 4. 公开 API（向后兼容 + 新增音量控制）───────────────────

  window.AudioImmersion = {
    unlock:      function () { AM.unlock(); },
    play:        function (name) { AM.play(name); },
    switchScene: function (sceneKey) { AM.switchScene(sceneKey); },
    msgSend:     function () { AM.msgSend(); },
    msgReceive:  function () { AM.msgReceive(); },
    setVolume:   function (group, value) { AM.setVolume(group, value); },
    getVolume:   function (group) { return AM.getVolume(group); },
    setMuted:    function (m) { return AM.setMuted(m); },
    toggleMute:  function () { return AM.toggleMute(); },
    isMuted:     function () { return AM.isMuted(); },
  };

  // ── 5. 启动初始化 ──────────────────────────────────────────

  AM.init();

  // ── 6. 自动播放策略：首次用户手势可靠解锁 ───────────────────
  // 捕获阶段监听任意手势（点击/触摸/按键），早于页面自身的监听器触发，
  // 确保音频上下文在第一次交互时即被解锁；解锁前排队的播放请求随后补播。

  var GESTURE_EVENTS = ['pointerdown', 'touchstart', 'keydown'];

  function onFirstGesture() {
    AM.unlock();
    if (AM.unlocked) removeGestureListeners();
  }

  function removeGestureListeners() {
    for (var i = 0; i < GESTURE_EVENTS.length; i++) {
      document.removeEventListener(GESTURE_EVENTS[i], onFirstGesture, true);
    }
  }

  for (var g = 0; g < GESTURE_EVENTS.length; g++) {
    document.addEventListener(GESTURE_EVENTS[g], onFirstGesture, true);
  }

  // ── 7. 钩子：开屏按钮「推开那扇窗」─────────────────────────

  var startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.addEventListener('click', function () {
      AM.unlock();
      AM.curtainOpened = true;
      AM.play('opening');

      // 启动当前场景的环境音
      var currentScene = document.body.dataset.scene || 'normal';
      AM.wantedScene = SCENE_AUDIO_MAP[currentScene] || 'normal';
      if (AM.unlocked) AM.startAmbient(AM.wantedScene);
    });
  }

  // ── 8. 钩子：场景切换交叉淡入淡出 ──────────────────────────

  var _originalSetScene = window.setScene;

  window.setScene = function (name, opts) {
    var prevScene = document.body.dataset.scene;

    // 先调用页面原有逻辑
    if (typeof _originalSetScene === 'function') {
      _originalSetScene(name, opts);
    }

    // 再处理音频交叉淡入淡出
    var nextAudio = SCENE_AUDIO_MAP[name] || name;
    var prevAudio = prevScene ? (SCENE_AUDIO_MAP[prevScene] || prevScene) : null;

    if (prevAudio !== nextAudio) {
      AM.switchScene(nextAudio);
    } else {
      AM.wantedScene = nextAudio;
      if (AM.unlocked && AM.curtainOpened && !AM.currentAmbient) {
        AM.startAmbient(nextAudio);
      }
    }
  };

  // ── 9. 钩子：消息发送音效 ──────────────────────────────────

  var _originalSend = window.send;

  window.send = function () {
    if (AM.curtainOpened) AM.msgSend();
    if (typeof _originalSend === 'function') {
      return _originalSend.apply(this, arguments);
    }
  };

  // ── 10. 钩子：消息接收音效 ─────────────────────────────────

  var _originalTypewrite = window.typewrite;

  window.typewrite = function (text, done) {
    // 雪花膏开始打字时播放接收音效（过短文本除外）
    if (AM.curtainOpened && text && text.length > 3) {
      AM.msgReceive();
    }
    if (typeof _originalTypewrite === 'function') {
      return _originalTypewrite.apply(this, arguments);
    }
  };

  // ── 11. 静音按钮 ───────────────────────────────────────────

  function updateMuteButton(muted) {
    var btn = document.getElementById('xuehuagaoMuteBtn');
    if (!btn) return;
    btn.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    btn.title = muted ? '开启声音' : '静音';
  }

  (function addMuteButton() {
    var btn = document.createElement('button');
    btn.id = 'xuehuagaoMuteBtn';
    btn.innerHTML = AM.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    btn.title = AM.muted ? '开启声音' : '静音';
    btn.setAttribute('aria-label', 'Toggle mute');

    // 样式 —— 与页面视觉一致
    btn.style.cssText = [
      'position: fixed',
      'top: 16px',
      'right: 16px',
      'z-index: 999',
      'width: 36px',
      'height: 36px',
      'border-radius: 50%',
      'background: rgba(255,255,255,0.08)',
      'backdrop-filter: blur(12px)',
      '-webkit-backdrop-filter: blur(12px)',
      'border: 1px solid rgba(255,255,255,0.12)',
      'color: rgba(255,255,255,0.7)',
      'cursor: pointer',
      'display: flex',
      'align-items: center',
      'justify-content: center',
      'transition: all 0.25s ease',
      'padding: 0',
    ].join(';');

    btn.addEventListener('mouseenter', function () {
      btn.style.background = 'rgba(255,255,255,0.15)';
      btn.style.color = 'rgba(255,255,255,0.9)';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.background = 'rgba(255,255,255,0.08)';
      btn.style.color = 'rgba(255,255,255,0.7)';
    });

    btn.addEventListener('click', function () {
      AM.unlock();
      AM.toggleMute();
    });

    document.body.appendChild(btn);
  })();

  // ── 12. 页面恢复可见时恢复音频上下文 ────────────────────────

  document.addEventListener('visibilitychange', function () {
    if (!AM.ctx || document.hidden) return;
    if (AM.ctx.state === 'suspended') {
      AM.ctx.resume().catch(function () { /* 静默忽略 */ });
    }
  });

  // ── 完成 ───────────────────────────────────────────────────

  console.log(LOG_PREFIX, '已注入。等待用户点击「推开那扇窗」...');

})();
