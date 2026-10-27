import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Разработка: next dev проксирует /api на Python-сервер (hsserver.py --dev).
// Сборка: статический экспорт в out/, который раздаёт сам hsserver.py.
export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      async rewrites() {
        return [{ source: "/api/:path*", destination: "http://127.0.0.1:8765/api/:path*" }];
      },
    };
  }
  return { output: "export", images: { unoptimized: true } };
}
