(function () {
  'use strict'

  var KEY = 'kestrel.motion'
  var canvas = document.getElementById('confetti')
  var toggle = document.getElementById('motion-off')
  var hint = document.getElementById('motion-hint')
  if (!toggle) return

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  var offByUser = (function () {
    try {
      return localStorage.getItem(KEY) === 'off'
    } catch (e) {
      return false
    }
  })()

  toggle.checked = offByUser

  function say(text) {
    if (hint) hint.textContent = text
  }

  function allowed() {
    return !offByUser && !reduced
  }

  if (reduced) say('系统开着「减少动态效果」，本页不再播放彩纸。')
  else if (offByUser) say('动效已关闭，这个选择会记在这台浏览器上。')
  else say('动效开着，只在本页进入时放一轮。')

  toggle.addEventListener('change', function () {
    offByUser = toggle.checked
    try {
      localStorage.setItem(KEY, offByUser ? 'off' : 'on')
    } catch (e) {}
    say(offByUser ? '动效已关闭，这个选择会记在这台浏览器上。' : '动效已打开，下次进入本页会再放一轮。')
  })

  if (!canvas || !allowed()) return

  var ctx = canvas.getContext('2d')
  if (!ctx) return

  var dpr = Math.min(window.devicePixelRatio || 1, 2)
  var W = 0
  var H = 0

  function resize() {
    W = canvas.clientWidth
    H = canvas.clientHeight
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  function onResize() {
    resize()
  }
  window.addEventListener('resize', onResize)

  var COLORS = ['#b4482c', '#d97a4c', '#fbefdf', '#4f6ef7', '#0ea5a5', '#e0526e', '#7c5cf0']
  var pieces = []

  function spawn(count, spread) {
    for (var i = 0; i < count; i++) {
      pieces.push({
        x: Math.random() * W,
        y: spread ? Math.random() * H * 0.35 : -20 - Math.random() * H * 0.25,
        vx: (Math.random() - 0.5) * 1.1,
        vy: 1.1 + Math.random() * 2.2,
        w: 6 + Math.random() * 7,
        h: 4 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.22,
        sway: Math.random() * Math.PI * 2,
        life: 0,
        span: 210 + Math.random() * 130,
        color: COLORS[(Math.random() * COLORS.length) | 0],
      })
    }
  }

  spawn(90)

  var raf = 0
  function frame() {
    ctx.clearRect(0, 0, W, H)
    for (var i = pieces.length - 1; i >= 0; i--) {
      var p = pieces[i]
      p.life++
      p.sway += 0.045
      p.x += p.vx + Math.sin(p.sway) * 0.7
      p.y += p.vy
      p.rot += p.vr
      var fade = p.life > p.span * 0.7 ? 1 - (p.life - p.span * 0.7) / (p.span * 0.3) : 1
      if (p.life >= p.span || p.y > H + 30) {
        pieces.splice(i, 1)
        continue
      }
      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, fade))
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      /* 绕短轴压一下宽度，彩纸就在翻转和平面之间来回 */
      ctx.scale(Math.abs(Math.cos(p.rot * 1.6)) * 0.75 + 0.25, 1)
      ctx.fillStyle = p.color
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
      ctx.restore()
    }
    if (pieces.length) raf = window.requestAnimationFrame(frame)
    else {
      ctx.clearRect(0, 0, W, H)
      window.removeEventListener('resize', onResize)
    }
  }
  raf = window.requestAnimationFrame(frame)
})()
