/**
 * pdfjs-dist 的类型垫片(Bridge 侧最小使用面)。
 * pdfjs-dist 4.x 的 legacy build 不随附 .d.ts,这里只声明附件模块用到的导出。
 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getDocument(src: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getPage(index: number): Promise<any>;
      destroy(): Promise<void>;
    }>;
  };
  export const GlobalWorkerOptions: { workerSrc: string };
}
