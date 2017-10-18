/**
 * index.ts
 *
 * Entry point for ONI's TypeScript Language Service integraiton
 */

/// <reference path="./../../../../definitions/Oni.d.ts" />
/// <reference path="./../../../../node_modules/typescript/lib/protocol.d.ts" />

import * as os from "os"
import * as path from "path"

import * as types from "vscode-languageserver-types"

import { QuickInfo } from "./QuickInfo"
import { TypeScriptServerHost } from "./TypeScriptServerHost"

export interface IDisplayPart {
    text: string
    kind: string
}

export type RequestHandler = (requestName: string, payload: any) => Promise<any>
export type NotificationHandler = (notificationName: string, payload: any) => void

export class LightweightLanguageClient {

    private _subscriptions: { [key: string]: Oni.Event<any> } = { }

    private _requestHandler: { [key: string]: RequestHandler } = { }
    private _notificationHandler:  { [key: string]: NotificationHandler } = { }

    public subscribe(notificationName: string, evt: Oni.Event<any>) {
        this._subscriptions[notificationName] = evt
    }

    public sendRequest<T>(fileName: string, requestName: string, protocolArguments: any): Promise<T> {

        const handler = this._requestHandler[requestName]

        if (handler) {
            return handler(requestName, protocolArguments)
        } else {
            return Promise.reject("Not implemented")
        }
    }

    public sendNotification(fileName: string, notificationName: string, protocolArguments: any): void {

        const notifier = this._notificationHandler[notificationName]

        if (notifier) {
            notifier(notificationName, protocolArguments)
        }
    }

    public handleRequest(requestName: string, handler: RequestHandler): void {
        this._requestHandler[requestName] = handler
    }

    public handleNotification(notificationName: string, notificationHandler: NotificationHandler): void {
        this._notificationHandler[notificationName] = notificationHandler
    }

    public notify(notificationName: string, payload: any): void {
        const notifierEvent = this._subscriptions[notificationName]

        if (notifierEvent) {
            (<any>notifierEvent).dispatch(payload)
        }
    }

}

export const activate = (Oni) => {

    const host = new TypeScriptServerHost(Oni)
    const quickInfo = new QuickInfo(Oni, host)

    const lastOpenFile = null

    let lastBuffer: string[] = []

    const findAllReferences = (textDocumentPosition: Oni.EventContext) => {
        return host.findAllReferences(textDocumentPosition.bufferFullPath, textDocumentPosition.line, textDocumentPosition.column)
            .then((val: protocol.ReferencesResponseBody) => {

                const mapResponseToItem = (referenceItem: protocol.ReferencesResponseItem) => ({
                    fullPath: referenceItem.file,
                    line: referenceItem.start.line,
                    column: referenceItem.start.offset,
                    lineText: referenceItem.lineText,
                })

                const output: Oni.Plugin.ReferencesResult = {
                    tokenName: val.symbolName,
                    items: val.refs.map((item) => mapResponseToItem(item)),
                }

                return output
            })
    }

    const getDefinition = (textDocumentPosition: Oni.EventContext) => {
        return host.getTypeDefinition(textDocumentPosition.bufferFullPath, textDocumentPosition.line, textDocumentPosition.column)
            .then((val: any) => {
                val = val[0]
                return {
                    filePath: val.file,
                    line: val.start.line,
                    column: val.start.offset,
                }
            })
    }

    const getFormattingEdits = (position: Oni.EventContext) => {
        return host.getFormattingEdits(position.bufferFullPath, 1, 1, lastBuffer.length, 0)
            .then((val) => {
                const edits = val.map((v) => {
                    const start = {
                        line: v.start.line,
                        column: v.start.offset,
                    }

                    const end = {
                        line: v.end.line,
                        column: v.end.offset,
                    }

                    return {
                        start,
                        end,
                        newValue: v.newText,
                    }

                })

                return {
                    filePath: position.bufferFullPath,
                    version: position.version,
                    edits,
                }
            })
    }

    const convertTypeScriptKindToCompletionItemKind = (kind: string): types.CompletionItemKind => {

        const typeScriptKindToCompletionKind = {
            "let": types.CompletionItemKind.Variable,
            "interface": types.CompletionItemKind.Interface,
            "alias": types.CompletionItemKind.Reference,
            "color": types.CompletionItemKind.Color,
            "const": types.CompletionItemKind.Value,
            "constructor": types.CompletionItemKind.Constructor,
            "class": types.CompletionItemKind.Class,
            "type": types.CompletionItemKind.Class,
            "directory": types.CompletionItemKind.File,
            "file": types.CompletionItemKind.File,
            "script": types.CompletionItemKind.File,
            "var": types.CompletionItemKind.Variable,
            "property": types.CompletionItemKind.Property,
            "parameter": types.CompletionItemKind.Variable,
            "module": types.CompletionItemKind.Module,
            "external module name": types.CompletionItemKind.Module,
            "method": types.CompletionItemKind.Method,
            "function": types.CompletionItemKind.Function,
            "unit": types.CompletionItemKind.Unit,
            "keyword": types.CompletionItemKind.Keyword,
            "text": types.CompletionItemKind.Text,
        }

        if (kind && typeScriptKindToCompletionKind[kind]) {
            return typeScriptKindToCompletionKind[kind]
        } else {
            return null
        }
    }

    const getCompletionDetails = (textDocumentPosition: Oni.EventContext, completionItem) => {

        if (!textDocumentPosition || !textDocumentPosition.bufferFullPath) {
            return Promise.resolve(null)
        }

        return host.getCompletionDetails(textDocumentPosition.bufferFullPath, textDocumentPosition.line, textDocumentPosition.column, [completionItem.label])
            .then((details) => {
                const entry = details[0]

                if (!entry) {
                    return null
                }

                return {
                    kind: convertTypeScriptKindToCompletionItemKind(entry.kind),
                    label: entry.name,
                    documentation: entry.documentation && entry.documentation.length ? entry.documentation[0].text : null,
                    detail: convertToDisplayString(entry.displayParts),
                }
            })
    }

    const getCompletions = (textDocumentPosition: Oni.EventContext) => {
        if (textDocumentPosition.column <= 1) {
            return Promise.resolve({
                completions: [],
            })
        }

        const currentLine = lastBuffer[textDocumentPosition.line - 1]
        let col = textDocumentPosition.column - 2
        let currentPrefix = ""

        while (col >= 0) {
            const currentCharacter = currentLine[col]

            if (!currentCharacter.match(/[_a-z]/i)) {
                break
            }

            currentPrefix = currentCharacter + currentPrefix
            col--
        }

        const basePos = col

        if (currentPrefix.length === 0 && currentLine[basePos] !== ".") {
            return Promise.resolve({
                base: currentPrefix,
                completions: [],
            })
        }

        Oni.log.verbose("Get completions: current line " + currentLine)

        return host.getCompletions(textDocumentPosition.bufferFullPath, textDocumentPosition.line, textDocumentPosition.column, currentPrefix)
            .then((val: any[]) => {

                const results = val
                    .filter((v) => v.name.indexOf(currentPrefix) === 0 || currentPrefix.length === 0)
                    .map((v) => ({
                        label: v.name,
                        kind: convertTypeScriptKindToCompletionItemKind(v.kind),
                    }))

                return {
                    base: currentPrefix,
                    completions: results,
                }
            })
    }

    const getSignatureHelp = (textDocumentPosition: Oni.EventContext) => {
        return host.getSignatureHelp(textDocumentPosition.bufferFullPath, textDocumentPosition.line, textDocumentPosition.column)
            .then((result) => {
                const items = result.items || []

                const signatureHelpItems = items.map((item) => ({
                    variableArguments: item.isVariadic,
                    prefix: convertToDisplayString(item.prefixDisplayParts),
                    suffix: convertToDisplayString(item.suffixDisplayParts),
                    separator: convertToDisplayString(item.separatorDisplayParts),
                    parameters: item.parameters.map((p) => ({
                        text: convertToDisplayString(p.displayParts),
                        documentation: convertToDisplayString(p.documentation),
                    })),
                }))

                return {
                    items: signatureHelpItems,
                    selectedItemIndex: result.selectedItemIndex,
                    argumentCount: result.argumentCount,
                    argumentIndex: result.argumentIndex,
                }
            })
    }

    const lightweightLanguageClient = new LightweightLanguageClient()

    Oni.language.registerLanguageClient("typescript", lightweightLanguageClient)
    Oni.language.registerLanguageClient("javascript", lightweightLanguageClient)

    lightweightLanguageClient.notify("window/logMessage", "Hello world")

//     Oni.registerLanguageService({
//         findAllReferences,
//         getCompletionDetails,
//         getCompletions,
//         getDefinition,
//         getFormattingEdits,
//         getQuickInfo,
//         getSignatureHelp,
//     })

    host.on("semanticDiag", (diagnostics) => {
        const fileName = diagnostics.file

        const diags = diagnostics.diagnostics || []

        const errors = diags.map((d) => {
            // Convert lines to zero-based to accomodate protocol
            const startPosition = types.Position.create(d.start.line - 1, d.start.offset)
            const endPosition = types.Position.create(d.end.line - 1, d.end.offset)
            const range = types.Range.create(startPosition, endPosition)

            return {
                type: null,
                message: d.text,
                range,
                severity: 1,
            }
        })

        Oni.diagnostics.setErrors("typescript-compiler", fileName, errors)
    })

    // TODO: Refactor to helpers?
    const getFilePrefix = () => {
        if (process.platform === "win32") {
            return "file:///"
        } else {
            return "file://"
        }
     }

    const unwrapFileUriPath = (uri: string) => decodeURIComponent((uri).split(getFilePrefix())[1])

    const protocolOpenFile = (message: string, payload: any) => {
        const textDocument: types.TextDocumentIdentifier = payload.textDocument
        const filePath = unwrapFileUriPath(textDocument.uri)
        host.openFile(filePath)
    }

    const protocolChangeFile = (message: string, payload: any) => {

        const textDocument: types.TextDocumentIdentifier = payload.textDocument
        const contentChanges: types.TextDocumentContentChangeEvent[] = payload.contentChanges

        const filePath = unwrapFileUriPath(textDocument.uri)

        const change = contentChanges[0]
        if (!change.range) {
            host.updateFile(filePath, change.text)
        } else {
            // TODO
        }
    }

    // const getQuickInfo = (textDocumentPosition: Oni.EventContext) => {
    //     return host.getQuickInfo(textDocumentPosition.bufferFullPath, textDocumentPosition.line, textDocumentPosition.column)
    //         .then((val: any) => {
    //             return {
    //                 title: val.displayString,
    //                 description: val.documentation,
    //             }
    //         })
    // }

    const getQuickInfo = async (protocolName: string, payload: any): Promise<types.Hover> => {

        const textDocument: types.TextDocument  = payload.textDocument
        const position: types.Position = payload.position

        const filePath = unwrapFileUriPath(textDocument.uri)
        const val = await host.getQuickInfo(filePath, position.line + 1, position.character + 1)

        return {
            contents: [val.displayString, val.documentation]
        }
    }

    lightweightLanguageClient.handleNotification("textDocument/didOpen", protocolOpenFile)

    lightweightLanguageClient.handleNotification("textDocument/didChange", protocolChangeFile)

    lightweightLanguageClient.handleRequest("textDocument/hover",  getQuickInfo)


    const updateFile = Oni.helpers.throttle((bufferFullPath, stringContents) => {
        host.updateFile(bufferFullPath, stringContents)
    }, 50)

    Oni.on("buffer-update", (args: Oni.BufferUpdateContext) => {

        if (!args.eventContext.bufferFullPath) {
            return
        }

        if (lastOpenFile !== args.eventContext.bufferFullPath) {
            host.openFile(args.eventContext.bufferFullPath)
        }

        lastBuffer = args.bufferLines

        updateFile(args.eventContext.bufferFullPath, args.bufferLines.join(os.EOL))

    })

    Oni.on("buffer-update-incremental", (args: Oni.IncrementalBufferUpdateContext) => {
        if (!args.eventContext.bufferFullPath) {
            return
        }

        const changedLine = args.bufferLine
        const lineNumber = args.lineNumber

        lastBuffer[lineNumber - 1] = changedLine

        host.changeLineInFile(args.eventContext.bufferFullPath, lineNumber, changedLine)
    })

    const getHighlightsFromNavTree = (navTree: protocol.NavigationTree[], highlights: any[]) => {
        if (!navTree) {
            return
        }

        navTree.forEach((item) => {
            const spans = item.spans
            const highlightKind = kindToHighlightGroup[item.kind]

            // if(!highlightKind)
            //     debugger

            spans.forEach((s) => {
                highlights.push({
                    highlightKind,
                    token: item.text,
                })
            })

            if (item.childItems) {
                getHighlightsFromNavTree(item.childItems, highlights)
            }
        })
    }

    Oni.on("buffer-enter", (args: Oni.EventContext) => {
        // // TODO: Look at alternate implementation for this
        host.openFile(args.bufferFullPath)

        host.getNavigationTree(args.bufferFullPath)
            .then((navTree) => {
                const highlights = []
                // debugger
                getHighlightsFromNavTree(navTree.childItems, highlights)

                Oni.setHighlights(args.bufferFullPath, "typescript", highlights)
            })
    })

    Oni.on("buffer-saved", (args: Oni.EventContext) => {
        host.getErrorsAcrossProject(args.bufferFullPath)

        host.getNavigationTree(args.bufferFullPath)
            .then((navTree) => {
                const highlights = []
                // debugger
                getHighlightsFromNavTree(navTree.childItems, highlights)

                Oni.setHighlights(args.bufferFullPath, "typescript", highlights)
            })
    })

    const kindToHighlightGroup = {
        let: types.SymbolKind.Variable,
        const: types.SymbolKind.Constant,
        var: types.SymbolKind.Variable,
        alias: types.SymbolKind.Package,
        function: types.SymbolKind.Method,
        method: types.SymbolKind.Function,
        property: types.SymbolKind.Property,
        class: types.SymbolKind.Class,
        interface: types.SymbolKind.Interface,
    }

    // TODO: Refactor to separate file
    const convertToDisplayString = (displayParts: IDisplayPart[]) => {
        let ret = ""

        if (!displayParts || !displayParts.forEach) {
            return ret
        }

        displayParts.forEach((dp) => {
            ret += dp.text
        })

        return ret
    }
}
