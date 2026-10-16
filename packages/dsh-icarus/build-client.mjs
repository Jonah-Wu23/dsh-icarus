import { build } from 'esbuild'

await build({
  entryPoints: ['src/client/index.tsx'], outfile: 'lib/client.js', bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'], jsx: 'automatic', sourcemap: true,
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-icarus",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})
