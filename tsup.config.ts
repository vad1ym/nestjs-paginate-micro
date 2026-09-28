import { defineConfig } from 'tsup'

export default defineConfig({
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    target: 'node24',
    splitting: false,
    sourcemap: true,
    external: ['@mikro-orm/core', '@nestjs/common', '@nestjs/swagger'],
    outExtension({ format }) {
        return { js: format === 'esm' ? '.mjs' : '.js' }
    },
})
