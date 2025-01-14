const { app, ipcMain, dialog } = require('electron')
const fs = require('fs-extra')
const path = require('path')
const getData = require('./getData').getData
const { version } = require('../../package.json')
const config = require('./config')
const fetch = require('electron-fetch').default
const { readJSON, saveJSON, existsFile } = require('./utils')

const uigfLangMap = new Map([
  ['zh-cn', 'chs'],
  ['zh-tw', 'cht'],
  ['de-de', 'de'],
  ['en-us', 'en'],
  ['es-es', 'es'],
  ['fr-fr', 'fr'],
  ['id-id', 'id'],
  ['ja-jp', 'ja'],
  ['ko-kr', 'kr'],
  ['pt-pt', 'pt'],
  ['ru-ru', 'ru'],
  ['th-th', 'th'],
  ['vi-vn', 'vi']
])

const getTimeString = () => {
  return new Date().toLocaleString('sv').replace(/[- :]/g, '').slice(0, -2)
}

const formatDate = (date) => {
  let y = date.getFullYear()
  let m = `${date.getMonth()+1}`.padStart(2, '0')
  let d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d} ${date.toLocaleString('zh-cn', { hour12: false }).slice(-8)}`
}

const fakeIdFn = () => {
  let id = 1000000000000000000n
  return () => {
    id = id + 1n
    return id.toString()
  }
}

const shouldBeString = (value) => {
  if (typeof value !== 'string') {
    return ''
  }
  return value
}

// a dictionary for looking up item ids
const itemIdDict = new Map()
// the md5 value for the dictionary
let itemIdDictMd5 = null
// the file name for saving item id dictionary
const itemIdDictFileName = 'item-id-dict.json'

// acquire dictionary based on give language
const fetchItemIdDict = async (lang = 'all') => {
  // fetch item id dict from api.uigf.org
  const response = await fetch(`https://api.uigf.org/dict/genshin/${lang}.json`)
  // update local dict
  Object.entries(await response.json()).forEach(
    ([lang, table]) => itemIdDict.set(
      // assign item id table based on language, and convert all id from number to string
      lang, new Map(Object.entries(table).map(([name, id]) => [name, String(id)]))
    )
  )
}

// acquire dictionary based on give language
const fetchItemIdDictMd5 = async (lang = 'all') => {
  const response = await fetch('https://api.uigf.org/md5/genshin')
  const responseJson = await response.json()
  return responseJson[lang]
}

// initialize item id dictionary
const initLookupTable = async () => {
  // if itemIdDictMd5 != null, that means itemIdDict has been init, no need to do it again
  if (itemIdDictMd5) {
    return
  }

  // try obtain dict md5
  try {
    itemIdDictMd5 = await fetchItemIdDictMd5()
  } catch (e) {
    console.log(`Unable to fetch latest item id dictionary md5 due to: ${e}`)
  }

  // if a locally cached dictionary does not exists
  if (!existsFile(itemIdDictFileName)) {
    await fetchItemIdDict();
    return;
  }

  // if a locally cached dictionary is found
  const data = await readJSON(itemIdDictFileName)
  // if itemIdDictMd5 is not successfully fetched previously
  if (!itemIdDictMd5 && data) itemIdDictMd5 = data.md5

  // if the data is null or the md5 does not match
  if (!data || data.md5 !== itemIdDictMd5) {
    // console.log('md5 check failed! Re-fetching...')
    await fetchItemIdDict()
    return;
  }

  // if the data is valid and the md5 matches
  // console.log('md5 check success!')
  data.lang.forEach(([lang, table]) => itemIdDict.set(lang, new Map(table)))
}

// save item id dictionary
const saveLookupTable = async () => {
  await saveJSON(itemIdDictFileName, { lang: itemIdDict, md5: itemIdDictMd5 })
}

// get item id
const getItemId = async (lang, name) => {
  // fetch item id from api.uigf.org if cannot find it from existing item id dictionary
  if (!itemIdDict.get(lang).has(name)) {
    const response = await fetch(`https://api.uigf.org/identify/genshin/${name}`)
    const responseJson = await response.json()
    if (!responseJson.item_id) {
      throw new Error(`Couldn't find the item_id for the ${name}.`)
    }
    itemIdDict.get(lang).set(name, responseJson.item_id.toString())
  }
  return itemIdDict.get(lang).get(name)
}

const uigfJson = async () => {
  const { dataMap, current } = getData()
  const data = dataMap.get(current)
  if (!data?.result.size) {
    throw new Error('数据为空')
  }
  const fakeId = fakeIdFn()
  const result = {
    info: {
      uid: data.uid,
      lang: data.lang,
      export_time: formatDate(new Date()),
      export_timestamp: Math.round(Date.now() / 1000),
      export_app: 'genshin-wish-export',
      export_app_version: `v${version}`,
      uigf_version: 'v2.4',
      region_time_zone: data.uid.startsWith('6') ? -5 : data.uid.startsWith('7') ? 1 : 8
    },
    list: []
  }
  const listTemp = []
  const uigfLang = uigfLangMap.get(data.lang)
  for (let [type, arr] of data.result) {
    for (let item of arr) {
      listTemp.push({
        gacha_type: shouldBeString(item[4]) || type,
        time: item[0],
        timestamp: new Date(item[0]).getTime(),
        name: item[1],
        item_type: item[2],
        item_id: await getItemId(uigfLang, item[1]),
        rank_type: `${item[3]}`,
        id: shouldBeString(item[5]) || '',
        uigf_gacha_type: type
      })
    }
  }
  listTemp.sort((a, b) => a.timestamp - b.timestamp)
  listTemp.forEach(item => {
    delete item.timestamp
    result.list.push({
      ...item,
      id: item.id || fakeId()
    })
  })
  return result
}

const start = async () => {
  await initLookupTable()
  const result = await uigfJson()
  await saveLookupTable()
  const filePath = dialog.showSaveDialogSync({
    defaultPath: path.join(app.getPath('downloads'), `UIGF_${result.info.uid}_${getTimeString()}`),
    filters: [
      { name: 'JSON文件', extensions: ['json'] }
    ]
  })
  if (filePath) {
    await fs.ensureFile(filePath)
    await fs.writeFile(filePath, JSON.stringify(result, null, config.readableJSON ? '\t' : null))
  }
}

ipcMain.handle('EXPORT_UIGF_JSON', async () => {
  await start()
})

module.exports = { uigfJson }