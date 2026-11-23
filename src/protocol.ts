import type { StudioMode, WebviewInitialState } from "./webviewHtml";

export type FileSlot = "plan" | "before" | "after" | "deadlock";

export type HostToWebviewMessage =
  | {
      type: "loadState";
      state: WebviewInitialState;
    }
  | {
      type: "documentChanged";
      mode: "plan" | "deadlock";
      fileName: string;
      text: string;
    }
  | {
      type: "filePicked";
      slot: FileSlot;
      name: string;
      text: string;
    }
  | {
      type: "requestShareOnline";
      redact: boolean;
    };

export type WebviewToHostMessage =
  | {
      type: "ready";
    }
  | {
      type: "copy";
      text: string;
      label?: string;
    }
  | {
      type: "exportFile";
      format: "html" | "markdown" | "native";
      suggestedName: string;
      contents: string;
    }
  | {
      type: "openOnline";
      url: string;
      copyToClipboard?: boolean;
    }
  | {
      type: "pickFile";
      slot: FileSlot;
    }
  | {
      type: "modeChanged";
      mode: StudioMode;
    };
