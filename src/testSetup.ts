Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({
    canvas: document.createElement("canvas"),
    filter: "none",
    font: "20px sans-serif",
    measureText: (text: string) => ({
      width: text.length * 10,
      actualBoundingBoxAscent: 16,
      actualBoundingBoxDescent: 4,
      fontBoundingBoxAscent: 16,
      fontBoundingBoxDescent: 4,
    }),
  }),
});
