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
})()
