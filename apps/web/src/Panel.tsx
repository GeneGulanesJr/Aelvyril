import { useState } from "preact/hooks";
import MarkdownIt from "markdown-it";
import type { Panel as PanelData } from "@aelvyril/ui-schema";

// html:false means raw HTML in model or extension output is escaped, never injected.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, i, o, e, s) => {
  tokens[i].attrSet("target", "_blank");
  tokens[i].attrSet("rel", "noopener noreferrer");
  return defaultLink(tokens, i, o, e, s);
};

export function Markdown({ text }: { text: string }) {
  return <div class="md" dangerouslySetInnerHTML={{ __html: md.render(text) }} />;
}

export function PanelView({ panel, onCommand }: { panel: PanelData; onCommand(command: string): void }) {
  return (
    <section class={`panel panel-${panel.kind}`}>
      {panel.title && <h3>{panel.title}</h3>}
      <PanelBody panel={panel} onCommand={onCommand} />
    </section>
  );
}

function PanelBody({ panel, onCommand }: { panel: PanelData; onCommand(command: string): void }) {
  switch (panel.kind) {
    case "markdown":
      return <Markdown text={panel.body} />;
    case "table":
      return (
        <div class="scroll">
          <table>
            <thead>
              <tr>{panel.columns.map((c) => <th>{c}</th>)}</tr>
            </thead>
            <tbody>
              {panel.rows.map((r) => (
                <tr>{r.map((v) => <td>{v === null ? "" : String(v)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list":
      return (
        <ul>
          {panel.items.map((i) => (typeof i === "string" ? <li>{i}</li> : <li><b>{i.label}</b>{i.detail && <span class="muted"> — {i.detail}</span>}</li>))}
        </ul>
      );
    case "diff":
      return (
        <pre class="diff">
          {panel.patch.split("\n").map((l) => (
            <div class={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>{l || " "}</div>
          ))}
        </pre>
      );
    case "actions":
      return (
        <div class="row">
          {panel.actions.map((a) => (
            <button class={`btn ${a.style ?? "default"}`} onClick={() => onCommand(a.command)}>{a.label}</button>
          ))}
        </div>
      );
    case "status":
      return <p class={`tone-${panel.tone ?? "info"}`}>{panel.text}</p>;
    case "form":
      return <FormPanel panel={panel} onCommand={onCommand} />;
  }
}

function FormPanel({ panel, onCommand }: { panel: Extract<PanelData, { kind: "form" }>; onCommand(c: string): void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const set = (name: string, v: string | boolean) => setValues((s) => ({ ...s, [name]: v }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCommand(`${panel.submit.command} ${JSON.stringify(values)}`);
      }}
    >
      {panel.fields.map((f) => (
        <label class="field">
          <span>{f.label}</span>
          {f.type === "textarea" ? (
            <textarea required={f.required} onInput={(e) => set(f.name, e.currentTarget.value)} />
          ) : f.type === "select" ? (
            <select required={f.required} onChange={(e) => set(f.name, e.currentTarget.value)}>
              <option value="" />
              {f.options?.map((o) => <option>{o}</option>)}
            </select>
          ) : f.type === "checkbox" ? (
            <input type="checkbox" onChange={(e) => set(f.name, e.currentTarget.checked)} />
          ) : (
            <input type="text" required={f.required} onInput={(e) => set(f.name, e.currentTarget.value)} />
          )}
        </label>
      ))}
      <button class="btn primary" type="submit">{panel.submit.label}</button>
    </form>
  );
}
