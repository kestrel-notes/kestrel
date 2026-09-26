(function () {
  'use strict'

  var THEME_KEY = 'kestrel.theme'
  var THEMES = ['cloud', 'paper', 'midnight', 'terminal']

  function storedTheme() {
    var t = document.documentElement.getAttribute('data-theme')
    return THEMES.indexOf(t) >= 0 ? t : 'cloud'
  }

  var switchBox = document.getElementById('theme-switch')
  if (switchBox) {
    var buttons = switchBox.querySelectorAll('button[data-theme-value]')
    var paint = function (active) {
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].setAttribute('aria-pressed', String(buttons[i].getAttribute('data-theme-value') === active))
      }
    }
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].addEventListener('click', function () {
        var next = this.getAttribute('data-theme-value')
        document.documentElement.setAttribute('data-theme', next)
        try {
          localStorage.setItem(THEME_KEY, next)
        } catch (e) {}
        paint(next)
      })
    }
    paint(storedTheme())
  }

  var links = Array.prototype.slice.call(document.querySelectorAll('.sidenav a[href^="#"]'))
  var targets = []
  for (var l = 0; l < links.length; l++) {
    var el = document.getElementById(links[l].getAttribute('href').slice(1))
    if (el) targets.push(el)
  }

  if (targets.length && 'IntersectionObserver' in window) {
    var onScreen = {}
    var label = function () {
      var picked = null
      for (var i = 0; i < targets.length; i++) {
        if (onScreen[targets[i].id]) {
          picked = targets[i]
          break
        }
      }
      if (!picked) {
        var best = null
        for (var j = 0; j < targets.length; j++) {
          var top = targets[j].getBoundingClientRect().top
          if (top <= 140 && (best === null || top > best.top)) best = { node: targets[j], top: top }
        }
        picked = best ? best.node : targets[0]
      }
      for (var k = 0; k < links.length; k++) {
        var current = links[k].getAttribute('href') === '#' + picked.id
        links[k].classList.toggle('is-current', current)
        if (current) links[k].setAttribute('aria-current', 'true')
        else links[k].removeAttribute('aria-current')
      }
    }
    var io = new IntersectionObserver(
      function (rows) {
        for (var r = 0; r < rows.length; r++) onScreen[rows[r].target.id] = rows[r].isIntersecting
        label()
      },
      { rootMargin: '-96px 0px -55% 0px' }
    )
    for (var t = 0; t < targets.length; t++) io.observe(targets[t])
    label()
  }

  var images = document.querySelectorAll('.shot img, .qr img')
  for (var m = 0; m < images.length; m++) {
    ;(function (img) {
      var mark = function () {
        var host = img.closest('.shot, .qr')
        if (host) host.classList.add('is-broken')
      }
      if (img.complete && img.naturalWidth === 0) mark()
      img.addEventListener('error', mark)
    })(images[m])
  }

  /* ---------- 点图看大图 ----------
     那十张是 2878×1800 的桌面窗口截图，压进 360px 的格子就读不了字了——手机上
     「点一下摊开看」不是锦上添花，是那几张图唯一有用的看法。
     覆盖层只在打开时才进 DOM，关掉就连节点一起摘掉：不留"看不见但 Tab 得到"的焦点陷阱。 */

  var openZoom = function (img) {
    if (document.querySelector('.zoom')) return
    var opener = img
    var scrim = document.createElement('div')
    scrim.className = 'zoom'
    scrim.setAttribute('role', 'dialog')
    scrim.setAttribute('aria-modal', 'true')
    scrim.setAttribute('aria-label', img.getAttribute('alt') || '大图')

    var big = document.createElement('img')
    big.src = img.currentSrc || img.src
    big.alt = img.getAttribute('alt') || ''

    var close = document.createElement('button')
    close.type = 'button'
    close.className = 'icon-btn zoom-close'
    close.setAttribute('aria-label', '关闭大图')
    close.textContent = '×'

    var hint = document.createElement('p')
    hint.className = 'zoom-hint'
    hint.setAttribute('aria-hidden', 'true')
    hint.textContent = '点任意处或按 Esc 关掉'

    scrim.appendChild(close)
    scrim.appendChild(big)
    scrim.appendChild(hint)

    var shut = function () {
      document.removeEventListener('keydown', onKey)
      scrim.remove()
      document.documentElement.classList.remove('is-zoomed')
      if (opener.focus) opener.focus()
    }
    var onKey = function (e) {
      if (e.key === 'Escape') shut()
    }
    scrim.addEventListener('click', shut)
    document.addEventListener('keydown', onKey)
    document.body.appendChild(scrim)
    document.documentElement.classList.add('is-zoomed')
    close.focus()
  }

  var main = document.querySelector('main')
  if (main) {
    main.addEventListener('click', function (e) {
      var img = e.target && e.target.tagName === 'IMG' ? e.target : null
      if (!img) return
      if (!img.complete || img.naturalWidth === 0) return // 缺图的那几格没东西可放大
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
      if (window.getSelection && String(window.getSelection())) return // 正在选字就别拦
      e.preventDefault()
      openZoom(img)
    })
  }

  /* ---------- 窄屏：顶栏菜单与说明页目录 ---------- */

  var navToggle = document.getElementById('nav-toggle')
  var navList = document.getElementById('topbar-links')
  if (navToggle && navList) {
    var closeNav = function () {
      navList.classList.remove('is-open')
      navToggle.setAttribute('aria-expanded', 'false')
      navToggle.setAttribute('aria-label', '打开菜单')
    }
    navToggle.addEventListener('click', function () {
      if (navList.classList.contains('is-open')) return closeNav()
      navList.classList.add('is-open')
      navToggle.setAttribute('aria-expanded', 'true')
      navToggle.setAttribute('aria-label', '关闭菜单')
    })
    navList.addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'A') closeNav()
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav()
    })
  }

  var toc = document.querySelector('.toc-toggle')
  if (toc) {
    toc.addEventListener('click', function () {
      var open = toc.parentNode.classList.toggle('is-open')
      toc.setAttribute('aria-expanded', String(open))
    })
  }

  /* ---------- 进场动效 ----------
     reduce 命中时**根本不注册** observer——只在 CSS 里把时长压成 0.01ms 是不够的，
     那样初始的 opacity:0 会一直留着，动效降级就变成了内容隐身。 */

  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var revealables = document.querySelectorAll('[data-reveal]')
  window.__revealObservers = 0
  if (revealables.length && !reduce && 'IntersectionObserver' in window) {
    var ro = new IntersectionObserver(
      function (rows) {
        for (var i = 0; i < rows.length; i++) {
          if (!rows[i].isIntersecting) continue
          rows[i].target.classList.add('is-in')
          ro.unobserve(rows[i].target) // 进过一次就再也不动它
        }
      },
      { threshold: 0.18, rootMargin: '0px 0px -10% 0px' }
    )
    for (var v = 0; v < revealables.length; v++) ro.observe(revealables[v])
    window.__revealObservers = 1
  } else {
    for (var w = 0; w < revealables.length; w++) revealables[w].classList.add('is-in')
  }

  /* ---------- hero 示意图的轻视差：窄屏与 reduce 下都不做 ---------- */

  var mock = document.getElementById('mock')
  if (mock && !reduce && window.matchMedia('(min-width: 781px)').matches) {
    var raf = 0
    window.addEventListener(
      'scroll',
      function () {
        if (raf) return
        raf = requestAnimationFrame(function () {
          raf = 0
          mock.style.transform = 'translateY(' + Math.min(window.scrollY * 0.06, 40).toFixed(1) + 'px)'
        })
      },
      { passive: true }
    )
  }

  /* ---------- 老链接不失效 ----------
     这一页以前是「首页 = 说明页」，#record / #privacy 那批锚点在 README、
     Releases 正文与别人的笔记链接里都出现过；首页改成展示页之后把它们转发过去。
     那两份表里的键就是旧首页还留在说明页上的 section id。「它不做什么」那一节整个删了，
     所以它不在这张表里——转发到一个不存在的锚点，比不转发更糟。
     `download` 也不在：这一页自己就有 `#download` 那一块（下载 CTA），把它弹到说明页是弹错地方。 */

  var LEGACY_SAME = ['screens', 'organize', 'looks', 'present', 'safety', 'keys', 'first-run', 'privacy']
  var LEGACY_MOVED = { overview: 'screens', record: 'write' }
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase()
  var hash = (location.hash || '').replace(/^#/, '')
  if ((page === '' || page === 'index.html') && hash) {
    var target = LEGACY_SAME.indexOf(hash) >= 0 ? hash : LEGACY_MOVED[hash]
    if (target) location.replace('guide.html#' + target)
  }
})()
