import { useEffect, useState } from "react";

const AUDIO_EXTENSIONS = ["wav", "wave", "mp3", "aif", "aiff", "flac", "ogg"];
const IMPORT_EXTENSIONS = ["zip", ...AUDIO_EXTENSIONS];

/** Native picker: a song's zip or its audio files. */
export async function pickSongFiles(): Promise<string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: true,
    title: "Selecciona el zip de la canción o sus pistas",
    filters: [
      { name: "Canción (zip o audio)", extensions: IMPORT_EXTENSIONS },
      { name: "Zip", extensions: ["zip"] },
      { name: "Audio", extensions: AUDIO_EXTENSIONS },
    ],
  });
  if (!picked) return null;
  return Array.isArray(picked) ? picked : [picked];
}

/** Files/folders dropped on the window start an import. */
export function useFileDrop(onPaths: (paths: string[]) => void, enabled: boolean) {
  const [hovering, setHovering] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setHovering(true);
          else if (p.type === "leave") setHovering(false);
          else if (p.type === "drop") {
            setHovering(false);
            if (p.paths.length > 0) onPaths(p.paths);
          }
        })
        .then((fn) => (cancelled ? fn() : (unlisten = fn))),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onPaths, enabled]);
  return hovering;
}
