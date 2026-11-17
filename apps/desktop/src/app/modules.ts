import {
  AudioLines,
  LayoutDashboard,
  ListMusic,
  Music,
  PencilRuler,
  Radio,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

export interface AppModule {
  id: string;
  path: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Development phase in which the module becomes functional. */
  phase: number;
}

/** Main navigation. Order reflects how a user moves through the app. */
export const MODULES: readonly AppModule[] = [
  {
    id: "dashboard",
    path: "/",
    label: "Dashboard",
    description: "Estado del sistema, motor de audio y base de datos.",
    icon: LayoutDashboard,
    phase: 1,
  },
  {
    id: "songs",
    path: "/songs",
    label: "Songs",
    description: "Biblioteca de canciones: buscar, ordenar, abrir, renombrar y quitar.",
    icon: Music,
    phase: 3,
  },
  {
    id: "studio",
    path: "/studio",
    label: "Multitrack Studio",
    description: "Reproducción multitrack sincronizada, tempo, forma de onda y partes de la canción.",
    icon: AudioLines,
    phase: 2,
  },
  {
    id: "setlists",
    path: "/setlists",
    label: "Setlists",
    description: "Listas de canciones por servicio o concierto: orden, notas y duración total.",
    icon: ListMusic,
    phase: 5,
  },
  {
    id: "live",
    path: "/live",
    label: "Live Mode",
    description: "Vista de escenario: setlist, saltos al compás, bucles y mezclador.",
    icon: Radio,
    phase: 5,
  },
  {
    id: "song-editor",
    path: "/song-editor",
    label: "Song Editor",
    description: "Dónde empieza y termina cada parte, tonalidad, compás y notas.",
    icon: PencilRuler,
    phase: 5,
  },
  {
    id: "audio-settings",
    path: "/audio-settings",
    label: "Audio Settings",
    description: "Tarjeta de sonido (ASIO / Windows), frecuencia, búfer, salidas de banda y click, tono de prueba.",
    icon: SlidersHorizontal,
    phase: 4,
  },
  {
    id: "settings",
    path: "/settings",
    label: "General Settings",
    description: "Atajos de teclado y copias de seguridad de la biblioteca.",
    icon: Settings,
    phase: 5,
  },
];
