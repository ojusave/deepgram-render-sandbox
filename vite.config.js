// Vite packages the browser files. Express serves the built folder locally and on Render.
import { defineConfig } from "vite";
export default defineConfig({ root: "web", build: { outDir: "../dist", emptyOutDir: true }, server: { host: "127.0.0.1" } });
