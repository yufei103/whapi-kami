import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import fs from 'fs'
import pino from 'pino'
import QRCode from 'qrcode'
import { pathToFileURL } from 'url'

// === Baileys: 延迟导入（新版是 ESM，不能静态 import）===
let makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay

let mainWindow
let sock

// === 📂 数据库路径 ===
const USER_DATA_PATH = app.getPath('userData')
const DB_FILE = join(USER_DATA_PATH, 'whapi_database.json')
const DB_TEMP_FILE = join(USER_DATA_PATH, 'whapi_database.temp.json')
const AUTH_FOLDER = join(USER_DATA_PATH, 'auth_info_baileys')
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true })
}

// === 初始化数据库 ===
let db = { labels: {}, labelMembers: {}, contacts: {}, chats: {} }
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { console.error('[DB] Load error:', e) }
}

// === 💾 异步保存 (防抖) ===
let saveTimeout
let isSaving = false
async function saveDb() {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(async () => {
    if (isSaving) return
    isSaving = true
    try {
      const jsonStr = JSON.stringify(db, null, 2)
      await fs.promises.writeFile(DB_TEMP_FILE, jsonStr)
      await fs.promises.rename(DB_TEMP_FILE, DB_FILE)
    } catch (err) {
      console.error('[DB] Save error:', err.message)
    } finally {
      isSaving = false
    }
  }, 2000)
}

// === 🔍 辅助函数 ===
function isRealUserMessage(msg) {
  if (!msg.message) return false
  if (msg.key.fromMe) return false
  if (msg.key.remoteJid === 'status@broadcast') return false
  let content = msg.message
  const wrapperKeys = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage', 'messageContextInfo', 'editedMessage']
  for (const key of wrapperKeys) {
    if (content[key] && content[key].message) content = content[key].message
  }
  const validTypes = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage', 'contactMessage']
  return validTypes.some(k => content[k])
}

function getMsgTimestamp(msg) {
  let ts = msg.messageTimestamp
  if (typeof ts === 'object' && ts !== null) ts = ts.low || ts
  return Number(ts)
}

function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

// === 🎲 随机延迟 ===
function getRandomDelay(minSec, maxSec) {
  return Math.floor(Math.random() * (maxSec - minSec) * 1000) + minSec * 1000
}

// === 🔀 Spintax 处理 ===
function processSpintax(text) {
  return text.replace(/\{([^{}]+)\}/g, (match, group) => {
    if (group.includes('|')) {
      const options = group.split('|')
      return options[Math.floor(Math.random() * options.length)]
    }
    return match
  })
}

// === 📝 变量替换 ===
function processVariables(text, contactName, jid) {
  const phone = jid ? jid.split('@')[0] : ''
  return text
    .replace(/\{name\}/gi, contactName || phone)
    .replace(/\{phone\}/gi, phone)
}

// === IPC 接口 ===
ipcMain.handle('get-db', () => {
  const displayDb = JSON.parse(JSON.stringify(db))
  const rawContacts = displayDb.contacts
  const finalContacts = {}
  const lidOwnerMap = {}

  Object.keys(rawContacts).forEach(key => {
    const contact = rawContacts[key]
    if (key.includes('@s.whatsapp.net') && contact.lid) {
      lidOwnerMap[contact.lid] = key
    }
  })

  Object.keys(rawContacts).forEach(key => {
    const contact = rawContacts[key]
    const isLid = key.includes('@lid')
    const isPn = key.includes('@s.whatsapp.net')

    if (isPn) {
      finalContacts[key] = contact
    } else if (isLid) {
      const ownerPn = lidOwnerMap[key]
      if (ownerPn) {
        const ownerContact = finalContacts[ownerPn]
        if (ownerContact) {
          if (!ownerContact.name && contact.name) ownerContact.name = contact.name
          if (!ownerContact.notify && contact.notify) ownerContact.notify = contact.notify
        }
      } else {
        finalContacts[key] = contact
      }
    } else {
      finalContacts[key] = contact
    }
  })

  displayDb.contacts = finalContacts
  return displayDb
})

ipcMain.handle('select-file', async (event, type) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  let filters = []
  if (type === 'image') filters = [{ name: 'Images', extensions: ['jpg', 'png', 'jpeg'] }]
  else if (type === 'video') filters = [{ name: 'Videos', extensions: ['mp4'] }]
  else filters = [{ name: 'Audio', extensions: ['mp3', 'ogg', 'mp4'] }]
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: filters })
  return (result.canceled || result.filePaths.length === 0) ? null : result.filePaths[0]
})

// === 📤 导出联系人 ===
ipcMain.handle('export-contacts', async (event, contactsList) => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出联系人',
    defaultPath: `whapi_contacts_${new Date().toISOString().slice(0,10)}.json`,
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return null
  try {
    const exportData = {
      exportDate: new Date().toISOString(),
      appVersion: 'WhapiKami V0',
      total: contactsList.length,
      contacts: contactsList
    }
    await fs.promises.writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
    return { success: true, path: result.filePath, count: contactsList.length }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// === 📥 导入联系人 ===
ipcMain.handle('import-contacts', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入联系人',
    properties: ['openFile'],
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  })
  if (result.canceled || result.filePaths.length === 0) return null
  try {
    const raw = await fs.promises.readFile(result.filePaths[0], 'utf-8')
    const data = JSON.parse(raw)
    if (!data.contacts || !Array.isArray(data.contacts)) {
      return { success: false, error: '文件格式不正确，缺少 contacts 数组' }
    }
    return { success: true, contacts: data.contacts, total: data.contacts.length, exportDate: data.exportDate }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('send-flow', async (event, { jid, contactName, flow, delaySettings }) => {
  try {
    console.log(`[Task] Sending to: ${jid}`)
    let targetJid = jid
    try {
      if (jid.includes('@s.whatsapp.net')) {
        const [result] = await sock.onWhatsApp(jid)
        if (result && result.exists) targetJid = result.jid
      }
    } catch (err) { }
    const d = delaySettings || {}
    for (const msg of flow) {
      const thinkTime = getRandomDelay(d.msgMin || 1, d.msgMax || 3)
      await delay(thinkTime)
      if (msg.type === 'text') {
        await sock.sendPresenceUpdate('composing', targetJid)
        const typingTime = getRandomDelay(d.typeMin || 0.5, d.typeMax || 1.5)
        await delay(typingTime)
        await sock.sendPresenceUpdate('paused', targetJid)
        let finalBody = processSpintax(msg.content)
        finalBody = processVariables(finalBody, contactName, targetJid)
        await sock.sendMessage(targetJid, { text: finalBody })
      } else if (msg.type === 'image' || msg.type === 'video') {
        if (!msg.path || !fs.existsSync(msg.path)) continue
        await sock.sendPresenceUpdate('composing', targetJid)
        const mediaTime = getRandomDelay(d.mediaMin || 1, d.mediaMax || 3)
        await delay(mediaTime)
        await sock.sendPresenceUpdate('paused', targetJid)
        let finalCaption = ""
        if (msg.content) {
          finalCaption = processSpintax(msg.content)
          finalCaption = processVariables(finalCaption, contactName, targetJid)
        }
        const buffer = fs.readFileSync(msg.path)
        if (msg.type === 'image') {
          await sock.sendMessage(targetJid, { image: buffer, caption: finalCaption, mimetype: 'image/jpeg' })
        } else {
          await sock.sendMessage(targetJid, { video: buffer, caption: finalCaption, mimetype: 'video/mp4' })
        }
      } else if (msg.type === 'audio') {
        if (fs.existsSync(msg.path)) {
          const recTime = getRandomDelay(d.recMin || 2, d.recMax || 5)
          await sock.sendPresenceUpdate('recording', targetJid)
          await delay(recTime)
          await sock.sendPresenceUpdate('paused', targetJid)
          const buffer = fs.readFileSync(msg.path)
          await sock.sendMessage(targetJid, { audio: buffer, ptt: true, mimetype: 'audio/mp4' })
        }
      }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error.message }
  }
})

// === 🔗 内部逻辑：关联 LID ===
const updateContactLid = (pnJid, lidJid) => {
  if (!pnJid || !lidJid) return
  if (!pnJid.includes('@s.whatsapp.net')) return
  if (!lidJid.includes('@lid')) return
  if (!db.contacts[pnJid]) db.contacts[pnJid] = { name: null, notify: null, verifiedName: null, lid: null }
  if (db.contacts[pnJid].lid !== lidJid) {
    db.contacts[pnJid].lid = lidJid
    console.log(`🔗 [Link] ${pnJid.split('@')[0]} <==> LID`)
    saveDb()
  }
}

// === 🔄 刷新数据 IPC ===
ipcMain.handle('refresh-data', async () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE))
    }
    sendToWindow('db-updated', true)
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

// === 🟢 WHATSAPP ENGINE ===
async function startWhatsApp() {
  // 动态导入 Baileys（新版是 ESM + top-level await，不能用静态 import）
  if (!makeWASocket) {
    const Baileys = await import('@whiskeysockets/baileys')
    makeWASocket = Baileys.default?.default || Baileys.default || Baileys
    useMultiFileAuthState = Baileys.useMultiFileAuthState
    DisconnectReason = Baileys.DisconnectReason
    Browsers = Baileys.Browsers
    delay = Baileys.delay
  }

  if (sock) {
    try { sock.ev.removeAllListeners(); sock.end(undefined); sock = null; } catch (e) { }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

  sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    syncFullHistory: true,
    browser: Browsers.windows('Desktop'),
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 5000,
    getMessage: async () => {
      return { conversation: 'hello' }
    }
  })

  const updateContactData = (id, data) => {
    if (!id) return false
    const jid = id.split(':')[0] + (id.includes('@lid') ? '@lid' : '@s.whatsapp.net')
    if (!db.contacts[jid]) {
      db.contacts[jid] = { name: null, notify: null, verifiedName: null, lid: null }
    }
    const old = db.contacts[jid]
    let changed = false
    if (data.name && data.name !== old.name) { old.name = data.name; changed = true }
    if (data.notify && data.notify !== old.notify) { old.notify = data.notify; changed = true }
    if (data.verifiedName && data.verifiedName !== old.verifiedName) { old.verifiedName = data.verifiedName; changed = true }
    if (data.lid && data.lid !== old.lid) { old.lid = data.lid; changed = true }
    return changed
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) sendToWindow('qr-code', url)
      })
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(startWhatsApp, 3000)
    } else if (connection === 'open') {
      console.log('[System] ✅ WhatsApp Connected!')
      sendToWindow('status', 'connected')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messaging-history.set', (data) => {
    const { contacts, chats, messages } = data
    let dbChanged = false
    if (contacts) {
      contacts.forEach(c => {
        if (updateContactData(c.id, c)) dbChanged = true
      })
    }
    if (chats) {
      chats.forEach(c => {
        const safeChat = {
          id: c.id, name: c.name, notify: c.notify,
          unreadCount: c.unreadCount, readOnly: c.readOnly,
          conversationTimestamp: c.conversationTimestamp
        }
        if (!db.chats[c.id]) {
          db.chats[c.id] = safeChat; db.chats[c.id].lastMessageRecvTimestamp = 0
        } else {
          const { lastMessageRecvTimestamp, ...updateData } = safeChat
          Object.assign(db.chats[c.id], updateData)
        }
        if (c.lid) updateContactLid(c.id, c.lid)
        if (updateContactData(c.id, { name: c.name, notify: c.notify })) {
          dbChanged = true
        }
      })
    }
    if (messages) {
      messages.forEach(msg => {
        const jid = msg.key.remoteJid
        const sender = msg.key.fromMe ? null : (msg.key.participant || jid)
        if (!db.chats[jid]) db.chats[jid] = { id: jid }
        const ts = getMsgTimestamp(msg)
        const currentLast = db.chats[jid].conversationTimestamp || 0
        if (ts > currentLast) {
          db.chats[jid].conversationTimestamp = ts
          db.chats[jid].lastMessage = msg
        }
        if (isRealUserMessage(msg)) {
          const currentRecv = db.chats[jid].lastMessageRecvTimestamp || 0
          if (ts > currentRecv) db.chats[jid].lastMessageRecvTimestamp = ts
        }
        // 🔧 追踪发出消息的状态（用于已读/已送达过滤）
        if (msg.key.fromMe && msg.status) {
          const curStatus = db.chats[jid].lastOutgoingStatus || 0
          if (msg.status >= curStatus) {
            db.chats[jid].lastOutgoingStatus = msg.status
          }
        }
        if (sender && msg.pushName) {
          if (updateContactData(sender, { notify: msg.pushName })) {
            dbChanged = true
          }
        }
      })
    }
    if (dbChanged) {
      saveDb()
      sendToWindow('db-updated', true)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return
    let needsSave = false
    for (const msg of messages) {
      const jid = msg.key.remoteJid
      const sender = msg.key.fromMe ? null : (msg.key.participant || jid)
      if (!db.chats[jid]) db.chats[jid] = { id: jid }
      const ts = getMsgTimestamp(msg)
      db.chats[jid].conversationTimestamp = ts
      db.chats[jid].lastMessage = msg
      if (isRealUserMessage(msg)) {
        db.chats[jid].lastMessageRecvTimestamp = ts
        console.log(`[Active] ${jid.split('@')[0]}`)
        needsSave = true
      }
      // 🔧 追踪发出消息的状态
      if (msg.key.fromMe && msg.status) {
        db.chats[jid].lastOutgoingStatus = msg.status
        needsSave = true
      }
      if (sender && msg.pushName) {
        if (updateContactData(sender, { notify: msg.pushName })) {
          needsSave = true
        }
      }
    }
    if (needsSave) {
      saveDb()
      sendToWindow('db-updated', true)
    }
  })

  // 🔧 新增：监听消息状态更新（送达、已读等）
  sock.ev.on('messages.update', (updates) => {
    let needsSave = false
    for (const { key, update } of updates) {
      if (key.fromMe && update.status !== undefined && update.status !== null) {
        const jid = key.remoteJid
        if (!db.chats[jid]) db.chats[jid] = { id: jid }
        const curStatus = db.chats[jid].lastOutgoingStatus || 0
        if (update.status >= curStatus) {
          db.chats[jid].lastOutgoingStatus = update.status
          needsSave = true
        }
      }
    }
    if (needsSave) {
      saveDb()
      sendToWindow('db-updated', true)
    }
  })

  sock.ev.on('contacts.upsert', (contacts) => {
    let hasUpdate = false
    contacts.forEach(c => {
      if (updateContactData(c.id, c)) hasUpdate = true
    })
    if (hasUpdate) {
      saveDb()
      sendToWindow('db-updated', true)
    }
  })

  sock.ev.on('contacts.update', (updates) => {
    let hasUpdate = false
    updates.forEach(u => {
      if (updateContactData(u.id, u)) hasUpdate = true
    })
    if (hasUpdate) {
      saveDb()
      sendToWindow('db-updated', true)
    }
  })

  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(c => {
      if (c.lid) updateContactLid(c.id, c.lid)
      updateContactData(c.id, { name: c.name, notify: c.notify })
    })
  })

  sock.ev.on('chats.update', (updates) => {
    updates.forEach(c => {
      if (c.lid) updateContactLid(c.id, c.lid)
      updateContactData(c.id, { name: c.name, notify: c.notify })
    })
  })

  sock.ev.on('labels.edit', (l) => {
    if(l.id){ db.labels[l.id] = l.name; saveDb() }
  })

  sock.ev.on('labels.association', (event) => {
    const events = Array.isArray(event) ? event : [event]
    events.forEach(e => {
      if (e.association?.type === 'label_jid') {
        const { labelId, chatId } = e.association
        if (!db.labelMembers[labelId]) db.labelMembers[labelId] = []
        if (e.type === 'add') {
          if (!db.labelMembers[labelId].includes(chatId)) db.labelMembers[labelId].push(chatId)
        } else if (e.type === 'remove') {
          db.labelMembers[labelId] = db.labelMembers[labelId].filter(id => id !== chatId)
        }
      }
    })
    saveDb()
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 900, show: false, autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show(); startWhatsApp();
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url); return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.whapi.app')

  // 🔧 修复：media:// 协议 — 用 net.fetch 支持 range requests（视频需要）
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url)
      let filePath = decodeURIComponent(url.pathname)
      if (filePath.startsWith('/') && filePath[2] === ':') {
        filePath = filePath.slice(1)
      }
      return net.fetch(pathToFileURL(filePath).href)
    } catch (err) {
      console.error('[Media Protocol] Error:', err.message)
      return new Response('File not found', { status: 404 })
    }
  })

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  createWindow()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
