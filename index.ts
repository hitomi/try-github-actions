import shell from 'shelljs'
import shellescape from 'shell-escape'
import path from 'path'
import fauna from 'faunadb'
import { v4 as UUIDv4 } from 'uuid'
import chalk from 'chalk'
import { maxBy } from 'lodash'
import fs from 'fs'
import sanitizeFilename from 'sanitize-filename'
import ytdl from 'ytdl-core'

require('dotenv').config()

const q = fauna.query

const FFMPEG = require('ffmpeg-static')

if (!shell.exec(shellescape([FFMPEG, '-version']), { silent: true })) {
  console.error('Require ffmpeg(https://ffmpeg.org)')
  process.exit()
}

const FAUNA_SECERT = process.env.FAUNA_SECERT!
const FAUNA_COLLECTION = process.env.FAUNA_COLLECTION!

if (!FAUNA_SECERT || !FAUNA_COLLECTION) {
  console.error('Require database config')
  process.exit()
}

export interface IResourceIndex {
  v: number
  resources: {
    [filename: string]: IResourceMeta
  }
}

export interface IResourceMeta {
  id: string
  refId: string
  title: string
  filename: string
  description?: string
  contributor?: {
    name: string
    link?: string
  }
  catalog?: string
  tags?: string[]
  source: {
    url: string
    title: string
    startTime: number
  }
  language?: {
    [key: string]: string
  }
  filemeta?: {
    md5?: string
    size?: number
    duration?: number
  }
}

function log(...argv: string[]) {
  console.log(chalk.bgBlue.white(' ❉ '), ...argv)
}

async function loadResourceFromDatabase() {
  const faunaClient = new fauna.Client({
    secret: FAUNA_SECERT
  })

  const query = await faunaClient.query<any>(
    q.Map(
      q.Paginate(q.Documents(q.Collection(FAUNA_COLLECTION))),
      q.Lambda("X", q.Get(q.Var('X')))
    )
  )


  const records = query.data.map((i: any) => {
    return ({ id: i.ref.value.id, ...i.data })
  })
  return records
}

interface IVideoMeta {
  id: string
  url: string
  title: string
  source: {
    asr: number
    url: string
  }
}

async function getVideoMeta(url: string) {
  try {
    ytdl.getURLVideoID(url)

    const info = await ytdl.getInfo(url, {
      requestOptions: {
        // headers,
      }
    })

    const bestFormat = maxBy(info.formats.filter((i) => i.hasAudio), (i) => +(i.audioSampleRate || 0))
    if (!bestFormat || !bestFormat.audioSampleRate) throw new Error('no_format_found')

    return {
      id: info.videoDetails.videoId,
      url: info.videoDetails.video_url,
      title: info.videoDetails.title,
      source: {
        asr: +bestFormat.audioSampleRate,
        url: bestFormat.url,
      },
      fetchedAt: new Date(),
    } as IVideoMeta
  } catch (err) {
    log(`Get video meta failed: ${url}`)
    console.error(err)

    return null
  }
}

interface IDownloadAndEncodeOptions {
  url: string
  output: string

  startTime?: string
  duration?: string
}

function downloadAndEncode({ url, startTime, duration, output }: IDownloadAndEncodeOptions) {
  shell.exec(shellescape([
    FFMPEG, '-hide_banner', '-nostdin',
    '-i', url,
    ...(startTime ? ['-ss', startTime] : []),
    ...(duration ? ['-t', duration] : []),
    '-vn',
    '-c:a', 'libmp3lame',
    output,
  ]))
}

async function downloadAudioclip() {
  log('Fetching posts from database...')

  const records = await loadResourceFromDatabase()
  log(`Found ${records.length} resource(s), waiting for download...`)

  const videoMetaCache = new Map<string, IVideoMeta>()
  const tempDir = path.resolve(__dirname, './.temp')
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir)
  }

  const metaFilePath = path.resolve(tempDir, './meta.json')
  const metaFile: IResourceIndex = fs.existsSync(metaFilePath) ? JSON.parse(fs.readFileSync(metaFilePath, 'utf-8')) : { v: 1, resources: {} }

  for (const record of records) {
    log(`Current: ${JSON.stringify(record)}`)

    const videoUrl = record.videoUrl
    const videoMeta = videoMetaCache.get(videoUrl) || await getVideoMeta(videoUrl)
    if (!videoMeta) {
      log(`Get download url failed, skip`)
      continue
    }

    if (!videoMetaCache.has(videoUrl)) videoMetaCache.set(videoUrl, videoMeta)

    log('Found:', chalk.green(videoMeta.title), 'Sampling rate:', chalk.green(videoMeta.source.asr))

    const filename = sanitizeFilename(`${record.id}-${record.title}.mp3`)
    const savePath = path.resolve(tempDir, filename)
    if (fs.existsSync(savePath)) {
      log(`File already exist, skip`)
      continue
    }

    downloadAndEncode({
      url: videoMeta.source.url,
      output: savePath,

      startTime: record.startTime,
      duration: record.duration,
    })

    const meta: IResourceMeta = {
      id: UUIDv4(),
      refId: record.id,
      title: record.title,
      filename,
      description: record.description,
      source: {
        url: videoMeta.url,
        startTime: record.startTime,
        title: record.title,
      },
      contributor: {
        name: record.author,
      },
    }

    metaFile.resources[filename] = meta

    log(`Saved`)
  }

  fs.writeFileSync(metaFilePath, JSON.stringify(metaFile), { encoding: 'utf-8' })
  log(`Meta file written`)
}

async function releaseAudioClip() {
  const tempDir = path.resolve(__dirname, './.temp')

  const metaFilePath = path.resolve(tempDir, './meta.json')
  if (!fs.existsSync(metaFilePath)) {
    log('nothing to release')
    return
  }

  const metaFile: IResourceIndex = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'))
}

async function main() {
  await downloadAudioclip()
}

main().catch(console.error)