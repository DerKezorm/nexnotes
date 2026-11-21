/** The tags dock onto the frame (`extensions.ts`): their place in the sidebar, the page of a tag and of all tags. */
import { FEATURE_ROUTES, SIDEBAR_SECTIONS } from '../extensions'
import { TagSection } from './TagSection'
import { AllTagsPage, TagPage } from './TagPage'

SIDEBAR_SECTIONS.push({ key: 'tags', render: () => <TagSection /> })
FEATURE_ROUTES.push({ path: 'tags', element: <AllTagsPage /> }, { path: 'tags/:tag', element: <TagPage /> })
