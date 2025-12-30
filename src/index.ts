import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// --- CONFIGURATION ---
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Telegram bot token not found in .env file.');
  process.exit(1);
}

const adminChatId: string | undefined = process.env.ADMIN_CHAT_ID;
if (!adminChatId || adminChatId === 'YOUR_ADMIN_CHAT_ID_HERE') {
  console.error('Admin Chat ID is not set in environment variable ADMIN_CHAT_ID. Please set it up.');
  process.exit(1);
}

// --- PERSISTENT STORAGE ---
const NEW_REPORTS_PATH = path.resolve(__dirname, '../reports_new.json');
const ARCHIVE_REPORTS_PATH = path.resolve(__dirname, '../reports_archive.json');

type Report = TelegramBot.Message[];
type ReportsDB = Record<string, Report[]>; // Category -> Array of reports

function loadDb(filePath: string): ReportsDB {
    try {
        if (!fs.existsSync(filePath)) return {};
        const data = fs.readFileSync(filePath, 'utf-8');
        return data ? JSON.parse(data) : {};
    } catch (e) {
        console.error(`Error loading ${filePath}, starting fresh.`, e);
        return {};
    }
}

function saveDb(filePath: string, db: ReportsDB): void {
    try {
        fs.writeFileSync(filePath, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error(`Error saving ${filePath}`, e);
    }
}

// --- STATE & DATA MANAGEMENT ---
type UserState = 'awaiting_content';
interface UserReportCollector {
  context: string;
  messages: TelegramBot.Message[];
}
const userStates = new Map<number, UserState>();
const userReportCollectors = new Map<number, UserReportCollector>();

const bot = new TelegramBot(token, { polling: true });

// --- BOT COMMANDS MENU ---
bot.setMyCommands([
  { command: '/start', description: 'Показать главное меню' },
  { command: '/send', description: 'Отправить собранный отчет' },
]);

// --- COMMAND HANDLERS ---
bot.onText(/\/start/, (msg) => {
  userStates.delete(msg.chat.id);
  userReportCollectors.delete(msg.chat.id);
  sendMainMenu(msg.chat.id, 'Добро пожаловать! Выберите опцию из меню:');
});

bot.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    const collector = userReportCollectors.get(chatId);
    if (!collector || userStates.get(chatId) !== 'awaiting_content' || collector.messages.length === 0) {
        bot.sendMessage(chatId, 'Нечего отправлять. Сначала выберите пункт в меню /start и добавьте описание проблемы.');
        return;
    }
    
    const db = loadDb(NEW_REPORTS_PATH);
    if (!db[collector.context]) db[collector.context] = [];
    db[collector.context].push(collector.messages);
    saveDb(NEW_REPORTS_PATH, db);
    
    try {
        await bot.sendMessage(adminChatId, `🔔 Поступил новый отчет в категорию: *${collector.context}*`, { parse_mode: 'Markdown' });
    } catch (e) { console.error("Failed to send notification to admin", e); }

    userStates.delete(chatId);
    userReportCollectors.delete(chatId);
    bot.sendMessage(chatId, 'Спасибо! Ваш отчет был успешно отправлен и сохранен.');
});

// --- GENERAL MESSAGE HANDLER ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const isAdmin = msg.from?.id.toString() === adminChatId;

    // --- ADMIN REPLY LOGIC ---
    if (isAdmin && msg.reply_to_message) {
        const repliedTo = msg.reply_to_message;
        let targetId: number | undefined;

        // Case 1: Admin replies to the "Отчет от..." message (which contains ID)
        if (repliedTo.text?.includes('Отчет от') && repliedTo.text.includes('ID:')) {
            const match = repliedTo.text.match(/ID: (\d+)/);
            if (match) {
                targetId = parseInt(match[1], 10);
            }
        }
        // Case 2: Admin replies to a forwarded message from a user
        else if (repliedTo.forward_from) {
            targetId = repliedTo.forward_from.id;
        }

        if (targetId) {
            try {
                // Copy the admin's reply message to the target user
                await bot.copyMessage(targetId, chatId, msg.message_id);
                bot.sendMessage(chatId, '✅ Ваш ответ отправлен пользователю.');
            } catch (e) {
                console.error('Failed to send admin reply:', e);
                bot.sendMessage(chatId, '❌ Не удалось отправить ответ. Возможно, пользователь заблокировал бота или это бот.');
            }
            return; // Stop further processing for admin replies
        }
    }

    // --- REGULAR MESSAGE PROCESSING ---
    if (msg.text?.startsWith('/')) return;
    if (userStates.get(chatId) === 'awaiting_content') {
        userReportCollectors.get(chatId)?.messages.push(msg);
    } else {
        sendMainMenu(chatId, 'Пожалуйста, выберите команду из меню.');
    }
});

// --- CALLBACK (BUTTON PRESS) HANDLER ---
bot.on('callback_query', async (query) => {
  if (!query.message) return;
  const chatId = query.message.chat.id;
  const data = query.data || '';
  const isAdmin = chatId.toString() === adminChatId;
  bot.answerCallbackQuery(query.id);

  if (data === 'show_main_menu') {
    sendMainMenu(chatId, 'Главное меню:');
    return;
  }

  // --- ADMIN ACTIONS ---
  if (isAdmin) {
    const category = data.startsWith('admin_view_') ? data.replace('admin_view_', '') : 
                     data.startsWith('report_') ? data.replace('report_', '') : 
                     data.startsWith('show_archive_') ? data.replace('show_archive_', '') : 
                     data.startsWith('delete_archive_') ? data.replace('delete_archive_', '') : null;

    if (data.startsWith('admin_view_') || data.startsWith('report_')) {
        const newDb = loadDb(NEW_REPORTS_PATH);
        const reports = newDb[category!] || [];

        if (reports.length > 0) { // Show new reports
            bot.sendMessage(chatId, `--- Новые отчеты в "${category}" (${reports.length} шт.) ---`);
            for (const report of reports) {
                await forwardReport(chatId, report);
            }
            
            const archiveDb = loadDb(ARCHIVE_REPORTS_PATH);
            if (!archiveDb[category!]) archiveDb[category!] = [];
            archiveDb[category!].push(...reports);
            saveDb(ARCHIVE_REPORTS_PATH, archiveDb);
            
            delete newDb[category!];
            saveDb(NEW_REPORTS_PATH, newDb);

            bot.sendMessage(chatId, `--- Все новые отчеты в "${category}" показаны и перемещены в архив. ---`);
            sendMainMenu(chatId, 'Меню обновлено:');
        } else { // No new reports, check archive
            const archiveDb = loadDb(ARCHIVE_REPORTS_PATH);
            const archivedReports = archiveDb[category!] || [];

            if (archivedReports.length > 0) {
                // If archive exists, offer to show it
                bot.sendMessage(chatId, 'Новых отчетов в этой категории нет.');
                bot.sendMessage(chatId, 'Посмотреть или удалить архив?', {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Да, показать архив', callback_data: `show_archive_${category}` }],
                            [{ text: 'Удалить архив', callback_data: `delete_archive_${category}` }],
                            [{ text: 'Нет, вернуться в меню', callback_data: 'show_main_menu' }]
                        ]
                    }
                });
            } else {
                // If no new reports and no archive, just inform the user
                bot.sendMessage(chatId, 'Новых отчетов нет, архив для этой категории также пуст.');
                sendMainMenu(chatId, 'Главное меню:');
            }
        }
        return;
    } else if (data.startsWith('delete_archive_')) {
        const archiveDb = loadDb(ARCHIVE_REPORTS_PATH);
        if (archiveDb[category!]) {
            delete archiveDb[category!];
            saveDb(ARCHIVE_REPORTS_PATH, archiveDb);
            bot.sendMessage(chatId, `Архив для категории "${category!}" успешно удален.`);
        } else {
            bot.sendMessage(chatId, `Архив для категории "${category!}" уже пуст.`);
        }
        sendMainMenu(chatId, 'Главное меню:');
        return;
    } else if (data.startsWith('show_archive_')) {
        const archiveDb = loadDb(ARCHIVE_REPORTS_PATH);
        const reports = archiveDb[category!] || [];
        if (reports.length > 0) {
            bot.sendMessage(chatId, `--- Архив отчетов в "${category}" (${reports.length} шт.) ---`);
            for (const report of reports) {
                await forwardReport(chatId, report);
            }
        } else {
            bot.sendMessage(chatId, `Архив для категории "${category}" пуст.`);
        }
        sendMainMenu(chatId, 'Главное меню:');
        return;
    }
  }

  // --- USER ACTIONS ---
  if (!isAdmin && data.startsWith('report_')) {
    const context = data.replace('report_', '');
    userReportCollectors.delete(chatId);
    userStates.set(chatId, 'awaiting_content');
    userReportCollectors.set(chatId, { context, messages: [] });
    bot.sendMessage(chatId, `Вы выбрали: "${context}".\n\nПодробно опишите Вашу проблему, прикрепите фотографии, видео или документы. Когда закончите, выберите команду /send в меню.`);
  }
});

// --- HELPER FUNCTIONS ---
async function forwardReport(chatId: number, report: Report) {
    const senderId = report[0]?.from?.id;
    const senderName = `${report[0]?.from?.first_name || ''} ${report[0]?.from?.last_name || ''}`.trim();
    await bot.sendMessage(chatId, `Отчет от ${senderName} (ID: ${senderId})
`);
    for (const message of report) {
        await bot.forwardMessage(chatId, message.chat.id, message.message_id);
    }
}

function sendMainMenu(chatId: number, text: string) {
    const newReports = loadDb(NEW_REPORTS_PATH);
    const isAdmin = chatId.toString() === adminChatId;

    const keyboard = [
        ['Главный корпус', 'УЛК'], ['Анатомия', 'ДОС2'], ['Общежитие-1', 'Общежитие-3'],
        ['Общежитие-4', 'Общежитие-5'], ['Общежитие-6', 'Общежитие-7'],
    ].map(row => row.map(category => {
        const reportCount = newReports[category]?.length || 0;
        const buttonText = (isAdmin && reportCount > 0) ? `${category} (новые: ${reportCount})` : category;
        const callbackData = `report_${category}`;
        return { text: buttonText, callback_data: callbackData };
    }));
    
    bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

console.log('Bot is running...');
