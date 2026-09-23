import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** 渲染进程只加载本地资源：没有远程脚本、没有 eval、不发起网络请求。
 *
 *  只在 build 时注入。开发模式下 Vite 的 HMR 会在页面里插一段内联
 *  module script，'self' 会把它拦掉、热更新就废了；而打包产物里没有内联脚本，
 *  这时收紧 CSP 是纯收益。 */
function cspPlugin(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    // React 的内联 style 属性与主题变量注入需要它
    "style-src 'self' 'unsafe-inline'",
    // 附件走自注册的 kestrel-asset: 协议（主进程受控读取 <userData>/attachments/）；
    // 不放 file: 也不放 http(s):——离线与本地边界是产品红线，图片一律不外联
    "img-src 'self' data: blob: kestrel-asset:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ')

  return {
    name: 'kestrel-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@': resolve('src/renderer/src') },
    },
    plugins: [react(), cspPlugin()],
    build: {
      // electron-vite 三个 target 的 minify 默认都是 false。渲染进程的产物体积直接算进
      // 「冷启动到可输入」的预算里，这里开掉；main / preload 只有十几 KB，留着不压是为了
      // 用户报崩溃时堆栈能读。
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
})