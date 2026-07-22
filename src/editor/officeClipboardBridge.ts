export const NATIVE_OFFICE_CLIPBOARD_EVENT =
  "mlrt:write-native-office-clipboard";
export const NATIVE_OFFICE_CLIPBOARD_RESULT_EVENT =
  "mlrt:native-office-clipboard-result";

export interface NativeOfficeClipboardPayload {
  plain: string;
  rtf: string;
}

export interface NativeOfficeClipboardRequest
  extends NativeOfficeClipboardPayload {
  requestId: number;
}

export interface NativeOfficeClipboardResult {
  requestId: number;
  written: boolean;
}

let nextNativeClipboardRequestId = 0;

export function requestNativeOfficeClipboard(
  doc: Document,
  payload: NativeOfficeClipboardPayload,
): Promise<boolean> {
  const win = doc.defaultView;
  if (!win) {
    return Promise.resolve(false);
  }
  const requestId = ++nextNativeClipboardRequestId;
  return new Promise((resolve) => {
    const finish = (written: boolean): void => {
      win.clearTimeout(timeout);
      win.removeEventListener(
        NATIVE_OFFICE_CLIPBOARD_RESULT_EVENT,
        onResult as EventListener,
      );
      resolve(written);
    };
    const onResult = (event: CustomEvent<NativeOfficeClipboardResult>): void => {
      if (event.detail.requestId === requestId) {
        finish(event.detail.written);
      }
    };
    const timeout = win.setTimeout(() => finish(false), 8500);
    win.addEventListener(
      NATIVE_OFFICE_CLIPBOARD_RESULT_EVENT,
      onResult as EventListener,
    );
    win.dispatchEvent(
      new CustomEvent<NativeOfficeClipboardRequest>(
        NATIVE_OFFICE_CLIPBOARD_EVENT,
        { detail: { ...payload, requestId } },
      ),
    );
  });
}

export function reportNativeOfficeClipboardResult(
  win: Window,
  result: NativeOfficeClipboardResult,
): void {
  win.dispatchEvent(
    new CustomEvent<NativeOfficeClipboardResult>(
      NATIVE_OFFICE_CLIPBOARD_RESULT_EVENT,
      { detail: result },
    ),
  );
}
