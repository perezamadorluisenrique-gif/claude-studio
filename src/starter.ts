import { App, normalizePath } from "obsidian";

type Spec = Record<string, string | number | boolean | string[]>;

const yaml = (fm: Spec) =>
  "---\n" +
  Object.entries(fm)
    .map(([k, v]) =>
      Array.isArray(v) ? `${k}:${v.length ? "\n" + v.map((x) => `  - ${JSON.stringify(x)}`).join("\n") : " []"}` : `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`,
    )
    .join("\n") +
  "\n---\n";

const action = (fm: Spec, body: string) => yaml({ tags: ["tools"], ...fm }) + "\n" + body.trim() + "\n";

/** Starter library. Written only where the file doesn't exist yet, never overwritten. */
export const STARTER: Record<string, string> = {
  "Cómo funciona.md":
    yaml({ tags: ["tools"] }) +
    `
# Claude Studio — biblioteca

Cada nota en \`Actions/\` es una acción y cada nota en \`Profiles/\` es un perfil. Los cambios se recargan solos.

## Acciones

Propiedades:

- \`name\`, \`icon\` (nombre de [Lucide](https://lucide.dev)), \`group\`, \`order\`
- \`scope\`: \`selection\` · \`cursor\` · \`note\` · \`none\`
- \`output\`: \`replace\` · \`below\` · \`note\` (reescribe la nota con vista de diferencias) · \`new-note\` · \`modal\` · \`chat\` · \`property:<nombre>\`
- \`model\`: \`fast\` · \`write\` · \`chat\` o un modelo concreto
- \`tools\`: herramientas del CLI, por ejemplo \`[Read, Grep, Glob]\`. Vacío = ninguna.
- \`index: true\` envía la lista de títulos de notas para que los enlaces apunten a notas reales.
- \`bubble: true\` la muestra en la barra flotante de selección.

El cuerpo es el prompt. Variables: \`{{selection}}\`, \`{{cursor}}\`, \`{{note}}\`, \`{{title}}\`, \`{{path}}\`, \`{{tags}}\`, \`{{hub}}\`, \`{{snap}}\`, \`{{today}}\`, \`{{input}}\` (lo que escribes en la paleta). El contexto que el prompt no usa se adjunta al final.

## Perfiles

Se aplican según la nota activa: \`match_tags\`, \`match_folders\`, \`match_categories\` y \`priority\`. Un perfil sin reglas es el de reserva. El cuerpo se añade a las instrucciones de sistema, después de \`CLAUDE.md\`.
`,

  "Actions/Mejorar redacción.md": action(
    { name: "Mejorar redacción", icon: "wand-sparkles", group: "Editar", order: 10, scope: "selection", output: "replace", model: "fast", bubble: true },
    "Mejora la redacción del texto: más claro y fluido, mismo significado, mismo idioma y mismo registro. Conserva el formato Markdown y los enlaces.\n\n{{selection}}",
  ),
  "Actions/Corregir ortografía y gramática.md": action(
    { name: "Corregir ortografía y gramática", icon: "spell-check", group: "Editar", order: 20, scope: "selection", output: "replace", model: "fast", bubble: true },
    "Corrige solo ortografía, gramática y puntuación. No cambies el estilo, el vocabulario ni la estructura.\n\n{{selection}}",
  ),
  "Actions/Más corto.md": action(
    { name: "Más corto", icon: "minimize-2", group: "Editar", order: 30, scope: "selection", output: "replace", model: "fast", bubble: true },
    "Reescribe el texto con aproximadamente la mitad de palabras, sin perder ninguna idea importante.\n\n{{selection}}",
  ),
  "Actions/Más largo.md": action(
    { name: "Más largo", icon: "maximize-2", group: "Editar", order: 40, scope: "selection", output: "replace", model: "fast", bubble: true },
    "Desarrolla el texto con más detalle y ejemplos concretos. No inventes datos sobre la vida o los proyectos del autor: si falta información, amplía la explicación, no los hechos.\n\n{{selection}}",
  ),
  "Actions/Simplificar.md": action(
    { name: "Simplificar", icon: "feather", group: "Editar", order: 50, scope: "selection", output: "replace", model: "fast" },
    "Reescribe el texto con lenguaje sencillo y frases cortas.\n\n{{selection}}",
  ),
  "Actions/Tono formal.md": action(
    { name: "Tono formal", icon: "briefcase", group: "Editar", order: 60, scope: "selection", output: "replace", model: "fast" },
    "Reescribe el texto con un tono formal y profesional.\n\n{{selection}}",
  ),
  "Actions/Tono cercano.md": action(
    { name: "Tono cercano", icon: "smile", group: "Editar", order: 70, scope: "selection", output: "replace", model: "fast" },
    "Reescribe el texto con un tono cercano y natural.\n\n{{selection}}",
  ),
  "Actions/Convertir en lista.md": action(
    { name: "Convertir en lista", icon: "list", group: "Editar", order: 80, scope: "selection", output: "replace", model: "fast" },
    "Convierte el texto en una lista de viñetas clara, agrupando ideas relacionadas.\n\n{{selection}}",
  ),
  "Actions/Convertir en tabla.md": action(
    { name: "Convertir en tabla", icon: "table", group: "Editar", order: 90, scope: "selection", output: "replace", model: "fast" },
    "Convierte el texto en una tabla Markdown con las columnas que mejor lo representen.\n\n{{selection}}",
  ),
  "Actions/Traducir al inglés.md": action(
    { name: "Traducir al inglés", icon: "languages", group: "Editar", order: 100, scope: "selection", output: "replace", model: "fast" },
    "Traduce el texto al inglés. Conserva Markdown, enlaces y términos técnicos.\n\n{{selection}}",
  ),
  "Actions/Traducir al español.md": action(
    { name: "Traducir al español", icon: "languages", group: "Editar", order: 110, scope: "selection", output: "replace", model: "fast" },
    "Traduce el texto al español. Conserva Markdown, enlaces e identificadores de código.\n\n{{selection}}",
  ),

  "Actions/Explicar.md": action(
    { name: "Explicar", icon: "circle-help", group: "Escribir", order: 10, scope: "selection", output: "modal", model: "fast", bubble: true },
    "Explica este fragmento de forma breve y clara, en el idioma de la nota. Si hay términos técnicos, defínelos.\n\n{{selection}}",
  ),
  "Actions/Resumir nota.md": action(
    { name: "Resumir nota", icon: "scroll-text", group: "Escribir", order: 20, scope: "note", output: "below", model: "write" },
    "Escribe un resumen de la nota en 3-5 viñetas, empezando con un encabezado `## Resumen`. Solo lo que dice la nota.",
  ),
  "Actions/Extraer tareas.md": action(
    { name: "Extraer tareas", icon: "list-checks", group: "Escribir", order: 30, scope: "note", output: "below", model: "write" },
    "Extrae las tareas pendientes que aparecen en la nota como una lista `- [ ]`, bajo un encabezado `## Tareas`. Una por línea, verbo en infinitivo. No añadas tareas que la nota no mencione.",
  ),
  "Actions/Lluvia de ideas.md": action(
    { name: "Lluvia de ideas", icon: "lightbulb", group: "Escribir", order: 40, scope: "cursor", output: "below", model: "write" },
    "Propón 8 ideas concretas y variadas sobre {{input}} (si está vacío, sobre el tema del texto alrededor del cursor), como lista de viñetas con una frase cada una.",
  ),
  "Actions/Esquema.md": action(
    { name: "Esquema", icon: "list-tree", group: "Escribir", order: 50, scope: "cursor", output: "below", model: "write" },
    "Escribe un esquema con encabezados `##` y `###` para desarrollar {{input}} (si está vacío, el tema de la nota). Solo los encabezados y una línea de intención bajo cada uno.",
  ),
  "Actions/Continuar escribiendo.md": action(
    { name: "Continuar escribiendo", icon: "pen-line", group: "Escribir", order: 5, scope: "cursor", output: "below", model: "fast" },
    "Continúa el texto desde ⟦CURSOR⟧ con uno o dos párrafos en el mismo estilo, idioma y voz. Devuelve solo la continuación.\n\n{{cursor}}",
  ),

  "Actions/Sugerir enlaces.md": action(
    { name: "Sugerir enlaces", icon: "link", group: "Vault", order: 10, scope: "note", output: "note", model: "write", index: true },
    "Devuelve la nota completa añadiendo [[wikilinks]] a notas de <vault_notes> donde haya una conexión real (como máximo 8). No cambies ninguna otra palabra, ni el frontmatter.\n\n{{note}}",
  ),
  "Actions/Estructurar nota.md": action(
    { name: "Estructurar nota", icon: "heading", group: "Vault", order: 20, scope: "note", output: "note", model: "write" },
    "Devuelve la nota completa reorganizada con encabezados `##`/`###` según su contenido, respetando su densidad. No elimines información ni cambies el frontmatter.\n\n{{note}}",
  ),
  "Actions/Preguntar al vault.md": action(
    { name: "Preguntar al vault", icon: "message-circle-question", group: "Vault", order: 30, scope: "none", output: "chat", model: "chat", tools: ["Read", "Grep", "Glob"] },
    "{{input}}",
  ),

  "Profiles/General.md":
    yaml({ tags: ["tools"], name: "General", priority: 0 }) +
    "\nEscribe como el autor de la nota: prosa directa, encabezados jerárquicos, sin relleno. Respeta la densidad de la nota: captura rápida → breve; referencia o plan → más estructura.\n",
  "Profiles/Notas técnicas.md":
    yaml({ tags: ["tools"], name: "Notas técnicas", priority: 20, match_tags: ["code"] }) +
    "\nNota técnica de un proyecto de software. La prosa va en español; identificadores, comandos, rutas y mensajes de commit quedan en inglés y en `code`. Usa bloques de código con lenguaje. Sé preciso: no afirmes que algo está hecho o probado si la nota no lo dice.\n",
  "Profiles/Hubs de proyecto.md":
    yaml({ tags: ["tools"], name: "Hubs de proyecto", priority: 25, match_folders: ["Notes/Project Roots"], match_categories: ["Projects"] }) +
    "\nEsta es la nota-hub de un proyecto: estado, decisiones, pendientes y enlaces a las notas del proyecto. Prioriza estructura y estado actual; enlaza a las notas de detalle en vez de copiar su contenido.\n",
  "Profiles/Diario.md":
    yaml({ tags: ["tools"], name: "Diario", priority: 30, match_folders: ["Daily"], match_tags: ["journal"] }) +
    "\nNota de diario personal. Conserva la voz del autor y su primera persona. Nunca inventes hechos, emociones ni eventos: trabaja solo con lo que está escrito.\n",
  "Profiles/Estudio.md":
    yaml({ tags: ["tools"], name: "Estudio", priority: 10, match_tags: ["study", "escuela"] }) +
    "\nMaterial de estudio. Explica con claridad y ejemplos, define los términos nuevos y marca lo que conviene repasar.\n",
};

export async function installStarter(app: App, folder: string): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [rel, content] of Object.entries(STARTER)) {
    const p = normalizePath(`${folder}/${rel}`);
    if (app.vault.getAbstractFileByPath(p)) {
      skipped.push(p);
      continue;
    }
    const dir = p.split("/").slice(0, -1).join("/");
    if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
    await app.vault.create(p, content);
    created.push(p);
  }
  return { created, skipped };
}
