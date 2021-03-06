import { ConventionFunction, ConventionOptions, Convention } from '../typings/definitions'
import * as path from 'path'
import * as fs from 'fs'
import * as loaderUtils from 'loader-utils'
import * as SourceMap from 'source-map'
import * as webpack from 'webpack'
import {appendCodeAndCallback, getRequireStrings, resolveLiteral, wrapInRequireInclude, SimpleDependency} from '../utils/inject'
import {getFilesInDir} from '../utils'
import * as debug from 'debug'
const log = debug('convention-loader')

export const conventions: { [convention: string]: ConventionFunction } = {
  'extension-swap'(fullPath: string, query: ConventionOptions) {
    const basename = path.basename(fullPath)
    const noExtension = basename.substr(0, basename.lastIndexOf('.')) || basename
    let extensions: string[]
    if (Array.isArray(query.extension)) {
      extensions = query.extension
    } else {
      extensions = query.extension ? [query.extension] : ['.html', '.css']
    }
    const basepath = path.dirname(fullPath)
    return extensions.map(extension => path.join(basepath, noExtension + extension))
  },

  async 'all-files-matching-regex'(fullPath: string, query: ConventionOptions & {regex: RegExp, directory: string}, loaderInstance: Webpack.Core.LoaderContext) {
    const files = await getFilesInDir(query.directory, {
      regexFilter: query.regex,
      emitWarning: loaderInstance.emitWarning.bind(loaderInstance),
      emitError: loaderInstance.emitError.bind(loaderInstance),
      fileSystem: loaderInstance.fs,
      recursive: true
    })

    return files
      .filter(file => file.filePath !== loaderInstance.resourcePath)
      .map(file => file.filePath)
  },

  // async 'list-based'(fullPath: string, query: ConventionQuery & { packageProperty: string }, loaderInstance: Webpack.Core.LoaderContext) {

  // },
}

export default async function ConventionLoader (this: Webpack.Core.LoaderContext, source: string, sourceMap?: SourceMap.RawSourceMap) {
  this.async()

  const query = Object.assign({}, loaderUtils.parseQuery(this.query)) as ConventionOptions

  if (this.cacheable) {
    this.cacheable()
  }

  if (!query || !query.convention) {
    this.emitError(`No convention defined, passing through: ${this.currentRequest} / ${this.request}`)
    this.callback(undefined, source, sourceMap)
    return
  }

  // log(`Convention loading ${path.basename(this.resourcePath)}`)

  let requires: Array<string> = []
  const maybeAddResource = async (input: string | string[] | Promise<string | string[]>) => {
    if (!input) return
    const value = (input as Promise<string | string[]>).then ? await input : input as string | string[]
    const fullPaths = typeof value === 'string' ? [value] : value
    await Promise.all(fullPaths.map(async fullPath => {
      const stat = await new Promise<fs.Stats>((resolve, reject) =>
        this.fs.stat(fullPath, (err, value) => resolve(value)))
      if (stat) {
        requires.push(fullPath)
      }
    }))
  }

  const actOnConvention = async (convention: Convention) => {
    if (typeof convention === 'function') {
      await maybeAddResource(convention(this.resourcePath, query, this))
    } else {
      if (conventions[convention])
        await maybeAddResource(conventions[convention](this.resourcePath, query, this))
      else
        throw new Error(`No default convention named '${convention}' found`)
    }
  }

  try {
    if (typeof query.convention !== 'function' && typeof query.convention !== 'string') {
      await Promise.all(query.convention.map(actOnConvention))
    } else {
      await actOnConvention(query.convention)
    }

    if (!requires.length) {
      this.callback(undefined, source, sourceMap)
      return
    }

    const resourceDir = path.dirname(this.resourcePath)
    const relativeRequires = requires.map(r => ({ literal: `./${path.relative(resourceDir, r)}` }))

    log(`Adding resources to ${this.resourcePath}: ${relativeRequires.map(r => r.literal).join(', ')}`)

    const requireStrings = await getRequireStrings(
      relativeRequires, query.addLoadersCallback, this
    )

    const inject = requireStrings.map(wrapInRequireInclude).join('\n')
    return appendCodeAndCallback(this, source, inject, sourceMap)
  } catch (e) {
    log(e)
    this.emitError(e.message)
    this.callback(undefined, source, sourceMap)
  }
}
