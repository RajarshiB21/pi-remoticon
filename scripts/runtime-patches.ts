import { readFileSync } from "node:fs";
import ts from "typescript";
import type { PatchEntry } from "./core-patch-plan.js";

const compiled = new Map<string, { source: string; output: string }>();
let methodSource = "";
let methods = new Map<string, string>();

/** Compile maintained factories without loading or executing the target installation. */
export function runtimeSource(name: string): string {
  const source = readFileSync(new URL(`../patches/runtime/${name}.ts`, import.meta.url), "utf8");
  const cached = compiled.get(name);
  if (cached?.source === source) return cached.output;
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, newLine: ts.NewLineKind.LineFeed }, reportDiagnostics: true });
  if (result.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)) throw new Error(`Cannot compile ${name} runtime`);
  const output = result.outputText.replace(/^export /gm, "");
  compiled.set(name, { source, output });
  return output;
}

/** Locate one method in the named native class, never a generic addChild anchor. */
export function nativeMethod(files: ReadonlyMap<string, string>, className: string, methodName: string): string {
  const hits: string[] = [];
  for (const [path, text] of files) {
    if (!text.includes(`${className}=class`)) continue;
    if (methodSource !== text) {
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      methods = new Map();
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["AssistantMessageComponent", "ToolExecutionComponent", "InteractiveMode", "SkillInvocationMessageComponent"].includes(node.name.text) && node.initializer && ts.isClassExpression(node.initializer)) {
          for (const member of node.initializer.members) if (ts.isMethodDeclaration(member)) {
            const key = `${node.name.text}.${member.name.getText(source)}`;
            if (methods.has(key)) throw new Error(`Duplicate native method ${key}`);
            methods.set(key, member.getText(source));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      methodSource = text;
    }
    const method = methods.get(`${className}.${methodName}`);
    if (method) hits.push(method);
  }
  if (hits.length !== 1) throw new Error(`${className}.${methodName}: expected one native method, found ${hits.length}`);
  return hits[0];
}

export function runtimePatches(files: ReadonlyMap<string, string>): PatchEntry[] {
  const source = runtimeSource("assistant");
  const update = nativeMethod(files, "AssistantMessageComponent", "updateContent");
  const invalidate = nativeMethod(files, "AssistantMessageComponent", "invalidate");
  const render = nativeMethod(files, "AssistantMessageComponent", "render");
  const display = nativeMethod(files, "ToolExecutionComponent", "updateDisplay");
  const scoped = (method: string, change: (source: string) => string): PatchEntry => {
    const find = nativeMethod(files, "InteractiveMode", method);
    const replace = change(find);
    if (replace === find) throw new Error(`Missing tool-group anchor in ${method}`);
    return { name: `tool-groups-${method}`, find, replace };
  };
  const insertion = "component.setExpanded(this.toolOutputExpanded),this.chatContainer.addChild(component)";
  const grouped = "component.setExpanded(this.toolOutputExpanded),remoticonTools.add(this.chatContainer,component,this.outputPad,this.session.resourceLoader.getSkills().skills)";
  const failure = 'component.updateResult({content:[{type:"text",text:errorMessage2}],isError:!0})';
  return [
    { name: "assistant-content-runs", find: update, replace: `updateContent(message,isStreaming=this.isStreaming){this.remoticonPresenter??=(()=>{${source};return createAssistantPresenter})()({Container,Markdown,Text,MouseRegion,Spacer,truncateToWidth,getTheme:()=>theme,createMarkdownTransform});this.remoticonPresenter.call(this,message,isStreaming)}` },
    { name: "assistant-theme-invalidation", find: invalidate, replace: invalidate.replace("{", "{this.remoticonInvalidate?.();") },
    { name: "assistant-copy-lines", find: render, replace: render.replace("super.render(width)", "[...super.render(width)]") },
    { name: "tool-group-runtime", find: "InteractiveMode=class", replace: `remoticonSkillLines=(()=>{${runtimeSource("skill")};return createSkillPresenter})()({getTheme:()=>theme,wrapTextWithAnsi,truncateToWidth}),remoticonTools=(()=>{${runtimeSource("tool-group")};return createToolGroups})()({Container,AssistantMessageComponent,getTheme:()=>theme,truncateToWidth,resolvePath:resolveToCwd,skillLines:remoticonSkillLines}),InteractiveMode=class` },
    { name: "compact-explicit-skill", find: nativeMethod(files, "SkillInvocationMessageComponent", "updateDisplay"), replace: 'updateDisplay(){this.clear()}' },
    { name: "compact-skill-render-method", find: 'SkillInvocationMessageComponent=class extends Box{', replace: 'SkillInvocationMessageComponent=class extends Box{setOutputPad(padding){this.remoticonOutputPad=padding}render(width){return remoticonSkillLines({name:this.skillBlock.name,state:"done"},width,this.remoticonOutputPad??1)}' },
    scoped("addMessageToChat", value => {
      const anchor = "new SkillInvocationMessageComponent(skillBlock,this.getMarkdownThemeWithSettings());";
      const before = "if(component.setExpanded(this.toolOutputExpanded),this.chatContainer.addChild(component),skillBlock.userMessage){this.chatContainer.addChild(new Spacer(1));";
      const after = "this.chatContainer.addChild(userComponent)}}else{";
      if ([anchor, before, after].some(part => value.split(part).length !== 2)) throw new Error("Expected one explicit skill insertion");
      return value.replace(anchor, anchor + "component.setOutputPad(this.outputPad);")
        .replace(before, "component.setExpanded(this.toolOutputExpanded);if(skillBlock.userMessage){")
        .replace(after, "this.chatContainer.addChild(userComponent),this.chatContainer.addChild(new Spacer(1))}this.chatContainer.addChild(component)}else{");
    }),
    { name: "tool-group-observer", find: display, replace: `updateDisplay(){try{${display.slice(display.indexOf("{") + 1, -1)}}finally{this.remoticonChanged?.()}}` },
    scoped("handleEvent", value => {
      if (value.split(insertion).length !== 3) throw new Error("Expected two live tool insertions");
      return value.replaceAll(insertion, grouped)
        .replace(failure, `(component.remoticonStopped=this.streamingMessage.stopReason==="aborted",${failure})`)
        .replace('case"agent_settled":', 'case"agent_settled":remoticonTools.stop(this.chatContainer);');
    }),
    scoped("renderSessionItems", value => {
      if (value.split(insertion).length !== 2) throw new Error("Expected one replay tool insertion");
      return value.replace(insertion, grouped).replace(failure, `(component.remoticonStopped=message.stopReason==="aborted",${failure})`);
    }),
    scoped("showSettingsSelector", value => {
      const predicate = "child instanceof ToolExecutionComponent&&";
      if (value.split(predicate).length !== 3) throw new Error("Expected two image-setting traversals");
      const padding = "child instanceof AssistantMessageComponent||";
      if (value.split(padding).length !== 2) throw new Error("Expected one output-padding traversal");
      return value.replaceAll(predicate, "(child instanceof ToolExecutionComponent||child instanceof remoticonTools.Group)&&")
        .replace(padding, "child instanceof remoticonTools.Group||child instanceof SkillInvocationMessageComponent||" + padding);
    }),
    ...["setToolsExpanded", "toggleThinkingBlockVisibility"].map(method => scoped(method, value => {
      const notice = method === "setToolsExpanded" ? 'this.showStatus(`Tool output: ${expanded?"expanded":"collapsed"}`)' : 'this.showStatus(`Thinking blocks: ${this.hideThinkingBlock?"hidden":"visible"}`)';
      if (value.split(notice).length !== 2) throw new Error(`Expected one toggle announcement in ${method}`);
      return value.replace(notice, "this.ui.requestRender()");
    })),
  ];
}
