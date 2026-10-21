import { afterEach, expect, it, vi } from "vitest";
import { createGeneratedImageStrip } from "./generated-image-strip";
import { disposeAgentThreadCardMessageTree } from "./message-lifecycle";

const previews = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@platform/tauri/client", () => ({ files: { readCodexGeneratedImagePreview: previews.read } }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("reserves image dimensions and keeps the same frame after a decode failure", () => {
  const strip = createGeneratedImageStrip({ id: "images", images: [{ kind: "url", value: "https://example.com/image.png" }], language: "zh-CN" })!;
  const frame = strip.firstElementChild!;
  const image = strip.querySelector("img")!;
  expect([image.width, image.height]).toEqual([120, 120]);
  image.dispatchEvent(new Event("error"));
  expect(strip.firstElementChild).toBe(frame);
  expect(frame.getAttribute("data-image-state")).toBe("error");
  expect(frame.textContent).toBe("图片加载失败");
  disposeAgentThreadCardMessageTree(strip);
});

it("keeps the placeholder when a file preview is unavailable", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  previews.read.mockResolvedValueOnce(null);
  const strip = createGeneratedImageStrip({ id: "images", images: [{ kind: "file", value: "/tmp/image.png" }], language: "en-US" })!;
  const frame = strip.firstElementChild!;
  await vi.waitFor(() => expect(frame.getAttribute("data-image-state")).toBe("error"));
  expect(strip.firstElementChild).toBe(frame);
  expect(frame.textContent).toBe("Image unavailable");
  disposeAgentThreadCardMessageTree(strip);
});
