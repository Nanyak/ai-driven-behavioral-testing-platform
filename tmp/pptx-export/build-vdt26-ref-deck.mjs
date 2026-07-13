import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const projectRoot = "/Users/thangdq/ai-driven-behavioral-testing-platform";
const slideDir = path.join(projectRoot, "tmp/pdfs/vdt26_ref");
const outDir = path.join(projectRoot, "outputs");
const outPptx = path.join(outDir, "vdt26_ref_slide12_edited.pptx");
const previewDir = path.join(outDir, "vdt26_ref_slide12_edited_preview");

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });

  const presentation = Presentation.create({
    slideSize: { width: 1920, height: 1080 },
  });

  for (let index = 1; index <= 17; index += 1) {
    const slideNo = String(index).padStart(2, "0");
    const imagePath = path.join(slideDir, `slide-${slideNo}.png`);
    const imageBytes = await fs.readFile(imagePath);
    const slide = presentation.slides.add();
    slide.images.add({
      blob: imageBytes,
      contentType: "image/png",
      alt: `VDT26 reference slide ${index}`,
      fit: "cover",
      position: { left: 0, top: 0, width: 1920, height: 1080 },
    });
  }

  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    await writeBlob(
      path.join(previewDir, `${stem}.png`),
      await presentation.export({ slide, format: "png", scale: 1 }),
    );
  }

  await writeBlob(
    path.join(previewDir, "montage.webp"),
    await presentation.export({ format: "webp", montage: true, scale: 0.35 }),
  );

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(outPptx);
  console.log(outPptx);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
