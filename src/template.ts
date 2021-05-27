import { SFCBlock } from '@vue/component-compiler-utils'
import * as vueTemplateCompiler from 'vue-template-compiler'
import { TransformPluginContext } from 'rollup'
import { ResolvedOptions } from './index'
import { createRollupError } from './utils/error'
import { compileTemplate } from './template/compileTemplate'
import { RawSourceMap, SourceMapGenerator } from 'source-map'
import path from 'path'
import fs from 'fs'

const splitRE = /\r?\n/g
const emptyRE = /^(?:\/\/)?\s*$/

function generateSourceMap(
  filename: string,
  source: string,
  generated: string,
  sourceRoot: string,
  lineOffset: number
): RawSourceMap {
  const map = new SourceMapGenerator({
    file: filename.replace(/\\/g, '/'),
    sourceRoot: sourceRoot.replace(/\\/g, '/'),
  })
  map.setSourceContent(filename, source)
  generated.split(splitRE).forEach((line, index) => {
    if (!emptyRE.test(line)) {
      const originalLine = index + 1 + lineOffset
      const generatedLine = index + 1
      for (let i = 0; i < line.length; i++) {
        if (!/\s/.test(line[i])) {
          map.addMapping({
            source: filename,
            original: {
              line: originalLine,
              column: i,
            },
            generated: {
              line: generatedLine,
              column: i,
            },
          })
        }
      }
    }
  })
  return JSON.parse(map.toString())
}

export function compileSFCTemplate(
  source: string,
  block: SFCBlock,
  filename: string,
  { root, isProduction, vueTemplateOptions = {}, devServer }: ResolvedOptions,
  pluginContext: TransformPluginContext
) {
  const { tips, errors, code } = compileTemplate({
    source,
    filename,
    compiler: vueTemplateCompiler as any,
    transformAssetUrls: true,
    transformAssetUrlsOptions: {
      forceRequire: true,
    },
    isProduction,
    isFunctional: !!block.attrs.functional,
    optimizeSSR: false,
    prettify: false,
    preprocessLang: block.lang,
    ...vueTemplateOptions,
    compilerOptions: {
      whitespace: 'condense',
      ...(vueTemplateOptions.compilerOptions || {}),
    },
  })

  if (tips) {
    tips.forEach((warn) =>
      pluginContext.error({
        id: filename,
        message: typeof warn === 'string' ? warn : warn.msg,
      })
    )
  }

  if (errors) {
    errors.forEach((error) => {
      // 2.6 compiler outputs errors as objects with range
      if (
        vueTemplateCompiler.generateCodeFrame &&
        vueTemplateOptions.compilerOptions?.outputSourceRange
      ) {
        const { msg, start, end } = error as vueTemplateCompiler.ErrorWithRange
        return pluginContext.error(
          createRollupError(filename, {
            message: msg,
            frame: vueTemplateCompiler.generateCodeFrame(source, start, end),
          })
        )
      } else {
        pluginContext.error({
          id: filename,
          message: typeof error === 'string' ? error : error.msg,
        })
      }
    })
  }

  let map
  if (block) {
    let content = block.content
    if (block.src) {
      if (path.isAbsolute(block.src)) {
        content = fs.readFileSync(block.src, 'utf8')
      } else {
        content = fs.readFileSync(
          path.join(path.dirname(filename), block.src),
          'utf8'
        )
      }
    }
    let lineOffset = 0
    if (!block.src && block.content) {
      const lines = block.content.split(splitRE)
      let count = block.start
      for (let i = 0; i < lines.length; i++) {
        lineOffset = i
        count -= lines[i].length + 1
        if (count < 0) break
      }
    }
    map = generateSourceMap(filename, source, content, root, lineOffset)
  }

  // rewrite require calls to import on build
  return {
    code:
      transformRequireToImport(code) + `\nexport { render, staticRenderFns }`,
    map,
  }
}

export function transformRequireToImport(code: string): string {
  const imports: { [key: string]: string } = {}
  let strImports = ''

  code = code.replace(
    /require\(("(?:[^"\\]|\\.)+"|'(?:[^'\\]|\\.)+')\)/g,
    (_, name): any => {
      if (!(name in imports)) {
        imports[name] = `__$_require_${name
          .replace(/[^a-z0-9]/g, '_')
          .replace(/_{2,}/g, '_')
          .replace(/^_|_$/g, '')}__`
        strImports += 'import ' + imports[name] + ' from ' + name + '\n'
      }

      return imports[name]
    }
  )

  return strImports + code
}
