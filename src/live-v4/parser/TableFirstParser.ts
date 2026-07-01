import { parseMarkdownTables } from "../../shared/tableModel";
import {
  createLiveDocModel,
  LiveDocModel,
} from "../model/LiveDocModel";

export interface TableFirstParser {
  parse(text: string): LiveDocModel;
}

export function createTableFirstParser(): TableFirstParser {
  return {
    parse(text: string): LiveDocModel {
      const source = typeof text === "string" ? text : "";
      const tables = parseMarkdownTables(source);

      return createLiveDocModel({
        text: source,
        blocks: tables.map((table) => ({
          id: table.id,
          type: "table",
          from: table.from,
          to: table.to,
          lineFrom: table.startLine + 1,
          lineTo: table.endLine + 1,
        })),
      });
    },
  };
}
