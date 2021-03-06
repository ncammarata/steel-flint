'use babel'

import {CompositeDisposable, Emitter} from 'atom'
import {fileExists, getMessage, showError, realPath} from './helpers'
import {join as joinPath} from 'path'
import Editor from './editor'
import Connection from './connection'
import Commands from './commands'
import Linter from './linter'
import StatusIcon from './status-icon'
import Autocomplete from './autocomplete'

export default class Flint {
  constructor() {
    this.subscriptions = new CompositeDisposable()
    this.emitter = new Emitter()
    this.commands = new Commands()
    this.linter = new Linter()
    this.statusIcon = new StatusIcon()
    this.connections = new Map()
    this.editors = new Map()
    this.autocomplete = new Autocomplete()

    this.subscriptions.add(this.emitter)
    this.subscriptions.add(this.commands)
    this.subscriptions.add(this.linter)
    this.subscriptions.add(this.statusIcon)
    this.subscriptions.add(this.autocomplete)

    this.autocomplete.onShouldProvideEditor(({editor, info}) => {
      info.editor = this.editors.get(editor)
    })
  }
  activate() {

    // Connections
    this.onDidAddProject(({path, promises}) => {
      promises.push(realPath(path).then(realPath => {
        const configPath = joinPath(realPath, '.flint', '.internal', 'state.json')
        return fileExists(configPath, false).then(exists => {
          if (exists) {
            return Connection.create(realPath, configPath).then(connection => {
              this.handleConnection(realPath, connection)
            }, function(error) {
              console.error('Flint channel creation failed', error)
            })
          }
        })
      }))
    })

    // Paths
    let pathsQueue = Promise.resolve()
    this.subscriptions.add(atom.project.onDidChangePaths(paths => {
      pathsQueue.then(() => this.handlePaths(paths))
    }))
    this.handlePaths(atom.project.getPaths()).then(() => {
      // Editors
      atom.workspace.observeTextEditors(textEditor => {
        const connection = this.getConnectionByPath(textEditor.getPath())
        if (connection !== null) {
          const editor = new Editor(textEditor, connection)
          editor.onDidDestroy(() => {
            this.subscriptions.remove(editor)
            this.editors.delete(textEditor)
          })
          this.subscriptions.add(editor)
          this.editors.set(textEditor, editor)
        }
      })
      this.subscriptions.add(atom.workspace.onDidChangeActivePaneItem(paneItem => {
        this.statusIcon.setActivePane(this.editors.get(paneItem) || null)
      }))
      this.statusIcon.setActivePane(this.editors.get(atom.workspace.getActiveTextEditor()) || null)
    })

    // Misc
    this.commands.activate()
  }
  handleConnection(path, connection) {
    this.connections.set(path, connection)
    this.linter.registerConnection(connection)
    connection.onDidDestroy(() => {
      this.linter.unregisterConnection(connection)
    })
    connection.onMessage('compile:error', message => {
      const error = message.error
      if (typeof error.loc === 'undefined') {
        showError('[Compiler-Error] ' + error.message, error.stack)
        return
      }
      const errorMessage = getMessage(error)
      this.linter.setError(connection, error.fileName, {
        type: 'Error',
        text: errorMessage,
        filePath: error.fileName,
        range: [[error.loc.line - 1, error.loc.column - 1], [error.loc.line - 1, error.loc.column]]
      })
    })
    connection.onMessage('file:meta', message => {
      const filePath = joinPath(connection.getBaseDir(), message.file)
      const textEditor = this.getEditorByPath(filePath)
      if (textEditor !== null) {
        textEditor.updateMeta(message.views)
      }
    })
    connection.onMessage('compile:success', message => {
      this.linter.setError(connection, message.path, null)
    })
  }
  consumeLinter(linter) {
    this.linter.attach(linter)
  }
  consumeStatusBar(statusBar) {
    this.statusIcon.attach(statusBar)
  }
  getEditorByPath(path) {
    for (const [textEditor, editor] of this.editors) {
      if (textEditor.getPath() === path) {
        return editor
      }
    }
    return null
  }
  getConnectionByPath(path) {
    for (const connection of this.connections.values()) {
      if (path.indexOf(connection.getPath()) === 0) {
        return connection
      }
    }
    return null
  }
  handlePaths(paths) {
    const promises = []

    // Add new ones
    for (const newPath of paths) {
      if (!this.connections.has(newPath)) {
        this.emitter.emit('did-add-project', {path: newPath, promises})
      }
    }

    // Remove deleted ones
    for (const oldPath of this.connections.keys()) {
      if (paths.indexOf(oldPath) === -1) {
        const oldConnection = this.connections.get(oldPath)
        oldConnection.destroy()
        this.connections.delete(oldPath)
      }
    }

    return Promise.all(promises).catch(e => console.error(e))
  }
  onDidAddProject(callback) {
    return this.emitter.on('did-add-project', callback)
  }
  dispose() {
    this.config.clear()
    this.editors.clear()
    this.subscriptions.dispose()
  }
}
