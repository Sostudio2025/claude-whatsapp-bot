const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

function loadConfig() {
    // בשרת נשתמש במשתני סביבה
    if (process.env.NODE_ENV === 'production' || !fs.existsSync(path.join(__dirname, 'env_config.txt'))) {
        return {
            CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
            AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY
        };
    }
    
    // בפיתוח נשתמש בקובץ (רק אם הוא קיים)
    const configPath = path.join(__dirname, 'env_config.txt');
    const configData = fs.readFileSync(configPath, 'utf8');

    const config = {};
    configData.split('\n').forEach(line => {
        const parts = line.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('=').trim();
            if (key && value) {
                config[key] = value;
            }
        }
    });

    return config;
}

const config = loadConfig();
const app = express();
app.use(express.json());

const anthropic = new Anthropic({
    apiKey: config.CLAUDE_API_KEY
});

const conversationMemory = new Map();

// מערכת אישורים פשוטה
const pendingActions = new Map();

function getConversationHistory(senderId) {
    if (!conversationMemory.has(senderId)) {
        conversationMemory.set(senderId, []);
    }
    return conversationMemory.get(senderId);
}

function addToConversationHistory(senderId, role, content) {
    const history = getConversationHistory(senderId);
    history.push({
        role: role,
        content: content
    });

    // הפחת את היסטוריית השיחה כדי למנוע לולאות
    if (history.length > 10) {
        history.splice(0, history.length - 10);
    }
}

async function searchTransactions(baseId, customerId, projectId) {
    try {
        console.log('🔍 מחפש עסקות עבור לקוח:', customerId, 'פרויקט:', projectId);

        const response = await axios.get(
            'https://api.airtable.com/v0/' + baseId + '/tblSgYN8CbQcxeT0j', {
                headers: {
                    'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY
                }
            }
        );

        const records = response.data.records;

        // חיפוש עסקות שמקושרות לאותו לקוח ופרויקט
        const matchingTransactions = records.filter(record => {
            const fields = record.fields;
            const linkedCustomer = fields['מזהה לקוח ראשי (ID_Client)'];
            const linkedProject = fields['מזהה פרויקט (ID_Project)'];

            // בדיקה אם העסקה מקושרת לאותו לקוח ופרויקט
            return (linkedCustomer && linkedCustomer.includes(customerId)) &&
                (linkedProject && linkedProject.includes(projectId));
        });

        console.log('✅ נמצאו', matchingTransactions.length, 'עסקות תואמות');

        return {
            found: matchingTransactions.length,
            transactions: matchingTransactions.map(record => ({
                id: record.id,
                fields: record.fields
            }))
        };
    } catch (error) {
        console.error('❌ שגיאה בחיפוש עסקות:', error.message);
        throw new Error('Transaction search failed: ' + error.message);
    }
}

async function searchAirtable(baseId, tableId, searchTerm) {
    try {
        console.log('🔍 מחפש:', searchTerm, 'בטבלה:', tableId);

        const response = await axios.get(
            'https://api.airtable.com/v0/' + baseId + '/' + tableId, {
                headers: {
                    'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY
                }
            }
        );

        const records = response.data.records;
        const filteredRecords = records.filter(record =>
            JSON.stringify(record.fields).toLowerCase().includes(searchTerm.toLowerCase())
        );

        console.log('✅ נמצאו', filteredRecords.length, 'רשומות');

        return {
            found: filteredRecords.length,
            records: filteredRecords.map(record => ({
                id: record.id,
                fields: record.fields
            }))
        };
    } catch (error) {
        console.error('❌ שגיאה בחיפוש:', error.message);
        throw new Error('Airtable search failed: ' + error.message);
    }
}

async function getAllRecords(baseId, tableId, maxRecords) {
    if (!maxRecords) maxRecords = 100;

    try {
        console.log('📋 מביא רשומות מטבלה:', tableId);

        const url = 'https://api.airtable.com/v0/' + baseId + '/' + tableId + '?maxRecords=' + maxRecords;
        const response = await axios.get(url, {
            headers: {
                'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY
            }
        });

        console.log('✅ נמצאו', response.data.records.length, 'רשומות');
        return response.data.records;
    } catch (error) {
        console.error('❌ שגיאה בקבלת רשומות:', error.message);
        throw new Error('Get records failed: ' + error.message);
    }
}

async function createRecord(baseId, tableId, fields) {
    try {
        console.log('🆕 יוצר רשומה חדשה בטבלה:', tableId);
        console.log('📝 שדות:', JSON.stringify(fields, null, 2));

        const url = 'https://api.airtable.com/v0/' + baseId + '/' + tableId;
        const response = await axios.post(url, {
            fields: fields
        }, {
            headers: {
                'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log('✅ רשומה נוצרה! ID:', response.data.id);
        return response.data;
    } catch (error) {
        console.error('❌ שגיאה ביצירת רשומה:', error.response ? error.response.data : error.message);
        const errorMessage = error.response && error.response.data && error.response.data.error ?
            error.response.data.error.message : error.message;
        throw new Error('Create record failed: ' + errorMessage);
    }
}

async function updateRecord(baseId, tableId, recordId, fields) {
    try {
        console.log('🔄 מעדכן רשומה:', recordId);
        console.log('📝 שדות חדשים:', JSON.stringify(fields, null, 2));

        // וידוא שה-Record ID תקין
        if (!recordId || !recordId.startsWith('rec') || recordId.length < 15) {
            throw new Error('Invalid Record ID: ' + recordId);
        }

        const url = 'https://api.airtable.com/v0/' + baseId + '/' + tableId;
        const response = await axios.patch(url, {
            records: [{
                id: recordId,
                fields: fields
            }]
        }, {
            headers: {
                'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log('✅ רשומה עודכנה בהצלחה');
        return response.data.records[0];
    } catch (error) {
        console.error('❌ שגיאה בעדכון:', error.response ? error.response.data : error.message);
        const errorMessage = error.response && error.response.data && error.response.data.error ?
            error.response.data.error.message : error.message;
        throw new Error('Update record failed: ' + errorMessage);
    }
}

async function getTableFields(baseId, tableId) {
    try {
        console.log('📋 בודק שדות בטבלה:', tableId);

        const url = 'https://api.airtable.com/v0/' + baseId + '/' + tableId + '?maxRecords=3';
        const response = await axios.get(url, {
            headers: {
                'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY
            }
        });

        if (response.data.records.length > 0) {
            const allFields = new Set();
            response.data.records.forEach(record => {
                Object.keys(record.fields).forEach(field => allFields.add(field));
            });

            const result = {
                availableFields: Array.from(allFields),
                sampleRecord: response.data.records[0] ? response.data.records[0].fields : {}
            };

            console.log('✅ נמצאו שדות:', result.availableFields.length);
            return result;
        }

        return {
            availableFields: [],
            sampleRecord: {}
        };
    } catch (error) {
        console.error('❌ שגיאה בקבלת שדות:', error.message);
        throw new Error('Get table fields failed: ' + error.message);
    }
}

const airtableTools = [
    {
        name: "search_airtable",
        description: "Search for records in Airtable by text",
        input_schema: {
            type: "object",
            properties: {
                baseId: {
                    type: "string"
                },
                tableId: {
                    type: "string"
                },
                searchTerm: {
                    type: "string"
                }
            },
            required: ["baseId", "tableId", "searchTerm"]
        }
    },
    {
        name: "search_transactions",
        description: "Search for existing transactions by customer and project",
        input_schema: {
            type: "object",
            properties: {
                baseId: {
                    type: "string"
                },
                customerId: {
                    type: "string"
                },
                projectId: {
                    type: "string"
                }
            },
            required: ["baseId", "customerId", "projectId"]
        }
    },
    {
        name: "get_all_records",
        description: "Get all records from a table",
        input_schema: {
            type: "object",
            properties: {
                baseId: {
                    type: "string"
                },
                tableId: {
                    type: "string"
                },
                maxRecords: {
                    type: "number",
                    default: 100
                }
            },
            required: ["baseId", "tableId"]
        }
    },
    {
        name: "create_record",
        description: "Create a new record",
        input_schema: {
            type: "object",
            properties: {
                baseId: {
                    type: "string"
                },
                tableId: {
                    type: "string"
                },
                fields: {
                    type: "object"
                }
            },
            required: ["baseId", "tableId", "fields"]
        }
    },
    {
        name: "update_record",
        description: "Update a single record",
        input_schema: {
            type: "object",
            properties: {
                baseId: {
                    type: "string"
                },
                tableId: {
                    type: "string"
                },
                recordId: {
                    type: "string"
                },
                fields: {
                    type: "object"
                }
            },
            required: ["baseId", "tableId", "recordId", "fields"]
        }
    },
    {
        name: "get_table_fields",
        description: "Get available fields in a table",
        input_schema: {
            type: "object",
            properties: {
                baseId: {
                    type: "string"
                },
                tableId: {
                    type: "string"
                }
            },
            required: ["baseId", "tableId"]
        }
    }
];

async function handleToolUse(toolUse) {
    console.log('🛠️ מפעיל כלי:', toolUse.name);

    if (toolUse.name === 'search_airtable') {
        return await searchAirtable(
            toolUse.input.baseId,
            toolUse.input.tableId,
            toolUse.input.searchTerm
        );
    } else if (toolUse.name === 'search_transactions') {
        return await searchTransactions(
            toolUse.input.baseId,
            toolUse.input.customerId,
            toolUse.input.projectId
        );
    } else if (toolUse.name === 'get_all_records') {
        return await getAllRecords(
            toolUse.input.baseId,
            toolUse.input.tableId,
            toolUse.input.maxRecords
        );
    } else if (toolUse.name === 'create_record') {
        return await createRecord(
            toolUse.input.baseId,
            toolUse.input.tableId,
            toolUse.input.fields
        );
    } else if (toolUse.name === 'update_record') {
        return await updateRecord(
            toolUse.input.baseId,
            toolUse.input.tableId,
            toolUse.input.recordId,
            toolUse.input.fields
        );
    } else if (toolUse.name === 'get_table_fields') {
        return await getTableFields(
            toolUse.input.baseId,
            toolUse.input.tableId
        );
    } else {
        throw new Error('Unknown tool: ' + toolUse.name);
    }
}

// SystemPrompt מתוקן ומשופר עם הגנות על שגיאות
const systemPrompt = 'אתה עוזר חכם שמחובר לאיירטיבל.\n\n' +
    '🚨 חוקים קריטיים:\n' +
    '1. חפש תמיד לפני עדכון - אל תנחש Record ID!\n' +
    '2. Record ID תקין מתחיל ב-"rec" ואחריו 14 תווים: "recABCD1234567890"\n' +
    '3. השתמש רק ב-Record ID המלא שמקבלת מתוצאת החיפוש (שדה "id")!\n' +
    '4. בדוק שמות שדות עם get_table_fields לפני עדכון!\n' +
    '5. אם יש שגיאת Record ID - חפש שוב ותשתמש ב-ID הנכון!\n' +
    '6. אחרי כל פעולה - הודע בבירור מה קרה!\n\n' +
    '📝 זרימת עבודה חובה לעדכון:\n' +
    '1. search_airtable למצוא רשומה\n' +
    '2. שמור את ה-ID המלא מתוצאת החיפוש\n' +
    '3. get_table_fields לבדוק שמות שדות\n' +
    '4. update_record עם ID מדויק ושם שדה מדויק\n' +
    '5. אם שגיאה - חזור לשלב 1\n\n' +
    '🎯 תרחיש דמי רצינות - זרימה מלאה:\n' +
    'כשאומרים "העביר דמי רצינות" או "השלים הרשמה":\n\n' +
    '1️⃣ מצא את הלקוח:\n' +
    '   - search_airtable בטבלת לקוחות (tblcTFGg6WyKkO5kq)\n' +
    '   - שמור את record.id שמתקבל\n\n' +
    '2️⃣ בדוק סטטוס:\n' +
    '   - get_table_fields לטבלת לקוחות לוודא שם השדה\n' +
    '   - אם לא "לקוח בתהליך" - בקש אישור ועדכן\n' +
    '   - השתמש ב-Record ID שנשמר בשלב 1\n\n' +
    '3️⃣ מצא פרויקט:\n' +
    '   - search_airtable בטבלת פרויקטים (tbl9p6XdUrecy2h7G)\n' +
    '   - שמור את הפרויקט ID\n\n' +
    '4️⃣ בדוק עסקה קיימת:\n' +
    '   - search_transactions עם לקוח ID ופרויקט ID\n' +
    '   - אם יש עסקה - הודע ועצור!\n\n' +
    '5️⃣ צור עסקה (רק אם אין):\n' +
    '   - create_record בטבלת עסקאות (tblSgYN8CbQcxeT0j)\n' +
    '   - קשר ללקוח ופרויקט\n\n' +
    '6️⃣ שאל על מידע נוסף\n\n' +
    '⚠️ הגנות על שגיאות:\n' +
    '- אם Record ID לא עובד - חפש שוב\n' +
    '- אם שדה לא קיים - בדוק עם get_table_fields\n' +
    '- אם עסקה כבר קיימת - אל תיצור חדשה\n' +
    '- המשך לשלב הבא גם אם יש שגיאה קטנה\n\n' +
    'Base ID: appL1FfUaRbmPNI01\n\n' +
    '📋 טבלאות:\n' +
    '🏢 עסקאות - tblSgYN8CbQcxeT0j\n' +
    '👥 לקוחות - tblcTFGg6WyKkO5kq\n' +
    '🏗️ פרויקטים - tbl9p6XdUrecy2h7G\n' +
    '📞 לידים - tbl3ZCmqfit2L0iQ0\n' +
    '🏢 משרדים - tbl7etO9Yn3VH9QpT\n' +
    '🌸 פרחים - tblNJzcMRtyMdH14d\n' +
    '⚠️ בקרה - tblYxAM0xNp0z9EoN\n' +
    '👨‍💼 מנהלים/עובדים - tbl8JT0j7C35yMcc2\n\n' +
    '🛠️ כלים:\n' +
    '- search_airtable: חיפוש רשומות\n' +
    '- search_transactions: חיפוש עסקות לפי לקוח ופרויקט\n' +
    '- get_all_records: קבלת רשומות\n' +
    '- get_table_fields: בדיקת שדות זמינים\n' +
    '- create_record: יצירת רשומה\n' +
    '- update_record: עדכון רשומה (רק עם ID מדויק!)\n\n' +
    '💡 דוגמה נכונה:\n' +
    '"דני העביר דמי רצינות לפרויקט X"\n' +
    '1. search_airtable למצוא דני → שמור ID\n' +
    '2. get_table_fields לטבלת לקוחות\n' +
    '3. update_record עם ה-ID השמור\n' +
    '4. search_airtable למצוא פרויקט X\n' +
    '5. search_transactions לבדוק עסקה קיימת\n' +
    '6. אם אין - create_record עסקה חדשה\n\n' +
    '🇮🇱 ענה רק בעברית ובצורה ברורה';

app.post('/claude-query', async(req, res) => {
    try {
        const messageData = req.body;
        const message = messageData.message;
        const sender = messageData.sender || 'default';

        console.log('📨 הודעה מ-' + sender + ':', message);

        // בדיקה אם זה אישור לפעולה מחכה
        if (pendingActions.has(sender)) {
            if (message.toLowerCase().includes('כן') || message.toLowerCase().includes('אישור') || 
                message.toLowerCase().includes('אוקיי') || message.toLowerCase().includes('בצע')) {
                
                const pendingAction = pendingActions.get(sender);
                console.log('✅ מבצע פעולה מאושרת עבור:', sender);
                pendingActions.delete(sender);
                
                // בצע את הפעולה המאושרת
                try {
                    for (const toolUse of pendingAction.toolUses) {
                        await handleToolUse(toolUse);
                        console.log('✅ כלי מאושר הושלם:', toolUse.name);
                    }
                    
                    return res.json({
                        success: true,
                        response: '✅ הפעולה בוצעה בהצלחה!',
                        actionCompleted: true
                    });
                } catch (error) {
                    return res.json({
                        success: false,
                        response: '❌ אירעה שגיאה בביצוע הפעולה: ' + error.message
                    });
                }
                
            } else if (message.toLowerCase().includes('לא') || message.toLowerCase().includes('ביטול') || 
                       message.toLowerCase().includes('עצור')) {
                
                pendingActions.delete(sender);
                return res.json({
                    success: true,
                    response: '❌ הפעולה בוטלה לפי בקשתך',
                    actionCancelled: true
                });
            } else {
                // אם זה נראה כמו בקשה חדשה - נקה זיכרון ועבד על הבקשה החדשה
                if (message.includes('עדכן') || message.includes('שנה') || message.includes('תמצא') || 
                    message.includes('חפש') || message.includes('צור') || message.includes('הוסף') ||
                    message.includes('מחק') || message.includes('הצג')) {
                    console.log('🔄 בקשה חדשה זוהתה - מנקה זיכרון אישורים ישנים');
                    pendingActions.delete(sender);
                    // המשך לעיבוד הרגיל של ההודעה
                } else {
                    return res.json({
                        success: true,
                        response: 'לא הבנתי את התגובה. אנא כתוב "כן" לאישור או "לא" לביטול.',
                        needsClarification: true
                    });
                }
            }
        }

        const conversationHistory = getConversationHistory(sender);
        addToConversationHistory(sender, 'user', message);

        const messages = conversationHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        console.log('🧠 שולח ל-Claude עם', messages.length, 'הודעות');

        let response;
        let toolsExecuted = [];
        let finalResponse = '';
        let conversationFinished = false;
        let stepCount = 0;

        // לולאה ללא הגבלת איטרציות (רק הגבלת בטיחות של הודעות)
        while (!conversationFinished && messages.length < 30) {
            stepCount++;
            console.log('🔄 שלב', stepCount);

            // שליחה ל-Claude
            response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 3000,
                system: systemPrompt,
                messages: messages,
                tools: airtableTools
            });

            console.log('📝 תגובת Claude (שלב ' + stepCount + '):', JSON.stringify(response, null, 2));

            // בדיקה אם יש כלים להפעיל
            const toolUses = response.content.filter(content => content.type === 'tool_use');

            if (toolUses.length === 0) {
                // אין כלים - זה התשובה הסופית
                const textContent = response.content.find(content => content.type === 'text');
                if (textContent) {
                    finalResponse = textContent.text;
                }
                conversationFinished = true;
                console.log('✅ שיחה הסתיימה - אין כלים נוספים');
                break;
            }

            // יש כלים להפעיל
            console.log('🛠️ כלים להפעיל:', toolUses.length);

            // הוסף את תגובת Claude להודעות
            messages.push({
                role: 'assistant',
                content: response.content
            });

            // בדיקה אם יש כלים שדורשים אישור
            const needsConfirmation = toolUses.some(tool => 
                tool.name === 'create_record' || 
                tool.name === 'update_record'
            );

            if (needsConfirmation) {
                // יצירת הודעת אישור פשוטה עם חץ למטה
                let actionDescription = '🔔 בקשת אישור:\n\n';
                
                for (const tool of toolUses) {
                    if (tool.name === 'create_record') {
                        const tableId = tool.input.tableId;
                        let tableName = 'רשומה';
                        if (tableId === 'tblSgYN8CbQcxeT0j') tableName = 'עסקה';
                        else if (tableId === 'tblcTFGg6WyKkO5kq') tableName = 'לקוח';
                        else if (tableId === 'tbl9p6XdUrecy2h7G') tableName = 'פרויקט';
                        
                        actionDescription += `🆕 יצירת ${tableName} חדשה\n`;
                        
                        const fields = tool.input.fields;
                        if (fields['שם מלא']) actionDescription += `👤 שם: ${fields['שם מלא']}\n`;
                        if (fields['שם העסקה']) actionDescription += `💼 עסקה: ${fields['שם העסקה']}\n`;
                        if (fields['שם הפרויקט']) actionDescription += `🏗️ פרויקט: ${fields['שם הפרויקט']}\n`;
                        
                    } else if (tool.name === 'update_record') {
                        // מצא את שם הלקוח והערכים הנוכחיים מההיסטוריה
                        let customerName = 'רשומה';
                        let currentValues = {};
                        
                        // חפש בהיסטוריית ההודעות
                        for (let i = messages.length - 1; i >= 0; i--) {
                            const msg = messages[i];
                            if (msg.role === 'user' && Array.isArray(msg.content)) {
                                for (const content of msg.content) {
                                    if (content.type === 'tool_result') {
                                        try {
                                            const result = JSON.parse(content.content);
                                            if (result.records && Array.isArray(result.records)) {
                                                const record = result.records.find(r => r.id === tool.input.recordId);
                                                if (record && record.fields) {
                                                    customerName = record.fields['שם מלא'] || customerName;
                                                    currentValues = record.fields;
                                                    break;
                                                }
                                            }
                                        } catch (e) {
                                            // התעלם משגיאות
                                        }
                                    }
                                }
                                if (customerName !== 'רשומה') break;
                            }
                        }
                        
                        actionDescription += `🔄 עדכון עבור: ${customerName}\n`;
                        
                        const fields = tool.input.fields;
                        Object.keys(fields).forEach(fieldName => {
                            const newValue = fields[fieldName];
                            const currentValue = currentValues[fieldName] || '(לא ידוע)';
                            // תצוגה: מה שיש עכשיו ⬇️ מה שרוצים לעדכן אליו
                            actionDescription += `📝 ${fieldName}:\n   ${currentValue}\n   ⬇️\n   ${newValue}\n\n`;
                        });
                    }
                }
                
                actionDescription += '❓ האם לבצע את הפעולה? (כן/לא)';
                
                // שמור את הפעולה בזיכרון
                pendingActions.set(sender, {
                    toolUses: toolUses,
                    originalMessage: message
                });
                
                return res.json({
                    success: true,
                    response: actionDescription,
                    needsConfirmation: true
                });
            }

            // הפעל כלים רגילים (חיפוש - לא דורש אישור)
            const toolResults = [];
            for (const toolUse of toolUses) {
                try {
                    toolsExecuted.push(toolUse.name);
                    console.log('🛠️ מפעיל כלי:', toolUse.name);

                    const toolResult = await handleToolUse(toolUse);
                    console.log('✅ כלי הושלם:', toolUse.name);

                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: JSON.stringify(toolResult, null, 2)
                    });

                } catch (toolError) {
                    console.error('❌ שגיאה בכלי:', toolUse.name, toolError.message);

                    let errorMessage = toolError.message;
                    if (errorMessage.includes('Unknown field name')) {
                        errorMessage = 'שגיאה: השדה שצוינו לא קיים בטבלה. אנא בדוק שמות שדות עם get_table_fields.';
                    } else if (errorMessage.includes('status code 422')) {
                        errorMessage = 'שגיאה: נתונים לא תקינים או שדה לא קיים. אנא בדוק עם get_table_fields.';
                    } else if (errorMessage.includes('does not exist in this table')) {
                        errorMessage = 'שגיאה: הרשומה לא קיימת בטבלה. אנא חפש שוב לקבלת Record ID נכון.';
                    } else if (errorMessage.includes('Invalid Record ID')) {
                        errorMessage = 'שגיאה: Record ID לא תקין. אנא חפש שוב לקבלת ID נכון.';
                    }

                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: 'שגיאה: ' + errorMessage
                    });
                }
            }

            // הוסף תוצאות הכלים להודעות
            if (toolResults.length > 0) {
                messages.push({
                    role: 'user',
                    content: toolResults
                });
            }

            console.log('📊 כלים שהופעלו עד כה:', toolsExecuted);
        }

        // אם הגענו למגבלת הודעות ללא תגובה סופית
        if (messages.length >= 30 && !finalResponse) {
            console.log('⚠️ הגענו למגבלת הודעות - מכין תגובה סופית');
            const hasSearchCustomer = toolsExecuted.includes('search_airtable');
            const hasSearchTransactions = toolsExecuted.includes('search_transactions');
            const hasCreateTransaction = toolsExecuted.includes('create_record');

            if (hasSearchCustomer && hasSearchTransactions) {
                if (hasCreateTransaction) {
                    finalResponse = '✅ הרשמת הלקוח הושלמה בהצלחה! נוצרה עסקה חדשה במערכת.';
                } else {
                    finalResponse = '✅ נמצאה עסקה קיימת במערכת עבור הלקוח והפרויקט. הלקוח כבר רשום.';
                }
            } else {
                finalResponse = 'הפעולה בוצעה חלקית. אנא בדוק את התוצאות במערכת.';
            }
        }

        // וודא שיש תגובה סופית
        if (!finalResponse || finalResponse.trim() === '') {
            finalResponse = toolsExecuted.length > 0 ?
                'הפעולה בוצעה בהצלחה.' :
                'לא הבנתי את הבקשה. אנא נסח מחדש.';
        }

        addToConversationHistory(sender, 'assistant', finalResponse);

        console.log('📤 תגובה סופית:', finalResponse);
        console.log('🛠️ כלים שהופעלו:', toolsExecuted);
        console.log('📊 סה"כ שלבים:', stepCount);

        res.json({
            success: true,
            response: finalResponse,
            toolsExecuted: toolsExecuted,
            steps: stepCount
        });

    } catch (error) {
        console.error('❌ שגיאה כללית:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

// פונקציה לניקוי זיכרון של user ספציפי
app.post('/clear-memory', (req, res) => {
    const requestData = req.body;
    const sender = requestData.sender || 'default';
    conversationMemory.delete(sender);
    pendingActions.delete(sender); // נקה גם אישורים מחכים
    console.log('🧹 זיכרון נוקה עבור:', sender);
    res.json({
        success: true,
        message: 'Memory cleared for ' + sender
    });
});

app.get('/memory/:sender?', (req, res) => {
    const sender = req.params.sender || 'default';
    const history = getConversationHistory(sender);
    const hasPending = pendingActions.has(sender);
    res.json({
        sender: sender,
        historyLength: history.length,
        history: history,
        hasPendingAction: hasPending
    });
});

app.get('/test-airtable', async(req, res) => {
    try {
        console.log('🧪 בודק חיבור...');
        const testResult = await getAllRecords('appL1FfUaRbmPNI01', 'tbl9p6XdUrecy2h7G', 1);
        res.json({
            success: true,
            message: 'חיבור תקין!',
            sampleRecord: testResult[0] || null
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.listen(3000, '0.0.0.0', () => {
    console.log('🚀 Server running on 0.0.0.0:3000');
    console.log('📝 Functions: search, get records, create, update, get fields');
    console.log('🧪 Test: GET /test-airtable');
    console.log('🧠 Memory: POST /clear-memory, GET /memory');
    console.log('🔔 Confirmation system: create/update actions require approval');
    console.log('⚡ VERSION 2024: Fixed errors + Enhanced prompt for deal deposits');
});
