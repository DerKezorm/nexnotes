/**
 * Where the note features dock onto the frame. The frame shows no notes; a feature adds itself here once, from its own
 * module (imported in `main.tsx` before the first render), and the frame draws it in its place:
 *
 * - `FEATURE_ROUTES`: pages inside the signed-in shell, beside the start area (`/` stays `NotesHome` until a feature
 *   puts its own element at `''`, the index).
 * - `SIDEBAR_SECTIONS`: entries of the sidebar between the name and the account (new note, search, inbox, folders,
 *   smart folders, tags, trash), in the order of the drawing "Seitenleiste".
 * - `CONNECTION_SECTIONS`: cards of Settings, Connections (devices, nextasks, MCP keys, vault password).
 * - `SHELL_BANNERS`: bars over every page of the signed-in shell (the full storage of the attachments, NOTES-10).
 */
import type { ReactNode } from 'react'

export type FeatureRoute = { path: string; element: ReactNode }
export type Section = { key: string; render: () => ReactNode }

export const FEATURE_ROUTES: FeatureRoute[] = []
export const SIDEBAR_SECTIONS: Section[] = []
export const CONNECTION_SECTIONS: Section[] = []
export const SHELL_BANNERS: Section[] = []
