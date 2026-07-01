import { LiveDocModel } from "./model/LiveDocModel";

export interface RenderedLiveBlock {
  id: string;
  type: "table";
  sourceFrom: number;
  sourceTo: number;
}

export interface LiveProjection {
  model: LiveDocModel;
  renderedBlocks: RenderedLiveBlock[];
  metrics: {
    blockCount: number;
    renderedBlockCount: number;
  };
}

export function buildLiveProjection(model: LiveDocModel): LiveProjection {
  const renderedBlocks = model.blocks
    .filter((block) => block.type === "table")
    .map((block) => ({
      id: block.id,
      type: "table" as const,
      sourceFrom: block.from,
      sourceTo: block.to,
    }));

  return {
    model,
    renderedBlocks,
    metrics: {
      blockCount: model.blocks.length,
      renderedBlockCount: renderedBlocks.length,
    },
  };
}
