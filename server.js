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

// הגדרות לניהול זיכרון
const MEMORY_CONFIG = {
    MAX_HISTORY_LENGTH: 10,  // מקסימום הודעות בזיכרון
    CONTEXT_TIMEOUT_MS: 1000 * 60 * 30,  // 30 דקות - אחרי זה מתחילים שיחה חדשה
    CLEANUP_KEYWORDS: ['היי', 'שלום', 'בוקר טוב', 'ערב טוב', 'הי', 'מה נשמע', 'מה קורה'],
    NEW_CONVERSATION_KEYWORDS: ['התחל מחדש', 'שיחה חדשה', 'נקה זיכרון', 'מחק היסטוריה'],
    // מילות פעולה שמסמנות בקשה חדשה
    ACTION_KEYWORDS: ['צור', 'הוסף', 'עדכן', 'מצא', 'חפש', 'בדוק', 'הצג', 'רשום', 'הכנס', 'שנה', 'מחק', 'בטל'],
    // מילים שמסמנות התייחסות לפעולה קודמת
    CONTINUATION_KEYWORDS: ['כן', 'אישור', 'אוקיי', 'בצע', 'המשך', 'תמשיך', 'עוד', 'גם', 'בנוסף', 'כמו כן']
};

// מבנה משופר לזיכרון השיחות
const conversationData = new Map();

function getConversationData(senderId) {
    if (!conversationData.has(senderId)) {
        conversationData.set(senderId, {
            history: [],
            lastActivity: Date.now(),
            contextId: Math.random().toString(36).substring(7) // ID ייחודי לשיחה
        });
    }
    return conversationData.get(senderId);
}

// מערכת אישורים פשוטה
const pendingActions = new Map();

function getConversationHistory(senderId) {
    const data = getConversationData(senderId);
    
    // בדיקה אם עבר זמן רב מדי מההודעה האחרונה
    const timeSinceLastActivity = Date.now() - data.lastActivity;
    if (timeSinceLastActivity > MEMORY_CONFIG.CONTEXT_TIMEOUT_MS) {
        console.log('⏰ זמן רב עבר מהשיחה האחרונה - מתחיל שיחה חדשה');
        data.history = [];
        data.contextId = Math.random().toString(36).substring(7);
    }
    
    data.lastActivity = Date.now();
    return data.history;
}

function addToConversationHistory(senderId, role, content) {
    const data = getConversationData(senderId);
    
    // הוסף את ההודעה להיסטוריה
    data.history.push({
        role: role,
        content: content,
        timestamp: Date.now()
    });

    // הגבל את גודל ההיסטוריה
    if (data.history.length > MEMORY_CONFIG.MAX_HISTORY_LENGTH) {
        // שמור את 2 ההודעות הראשונות (לקונטקסט) ואת ה-8 האחרונות
        const firstTwo = data.history.slice(0, 2);
        const lastEight = data.history.slice(-8);
        data.history = [...firstTwo, ...lastEight];
        
        console.log('🧹 ניקוי היסטוריה - נשמרו 10 הודעות');
    }
    
    data.lastActivity = Date.now();
}

function shouldStartNewConversation(message, conversationHistory) {
    const lowerMessage = message.toLowerCase().trim();
    
    // בדיקה אם זו הודעת פתיחה טיפוסית
    if (MEMORY_CONFIG.CLEANUP_KEYWORDS.some(keyword => lowerMessage === keyword)) {
        return true;
    }
    
    // בדיקה אם המשתמש מבקש במפורש שיחה חדשה
    if (MEMORY_CONFIG.NEW_CONVERSATION_KEYWORDS.some(keyword => lowerMessage.includes(keyword))) {
        return true;
    }
    
    // בדיקה חכמה: האם זו בקשה חדשה שלא קשורה להקשר הקודם?
    if (conversationHistory.length > 0) {
        // בדוק אם ההודעה מכילה מילת פעולה חדשה
        const hasActionKeyword = MEMORY_CONFIG.ACTION_KEYWORDS.some(keyword => 
            lowerMessage.includes(keyword)
        );
        
        // בדוק אם ההודעה מכילה מילות המשך
        const hasContinuationKeyword = MEMORY_CONFIG.CONTINUATION_KEYWORDS.some(keyword => 
            lowerMessage === keyword || lowerMessage.startsWith(keyword + ' ')
        );
        
        // אם יש מילת פעולה ואין מילת המשך - כנראה זו בקשה חדשה
        if (hasActionKeyword && !hasContinuationKeyword) {
            // בדוק אם הבקשה שונה מהותית מההקשר הקודם
            const lastUserMessage = [...conversationHistory]
                .reverse()
                .find(msg => msg.role === 'user');
            
            if (lastUserMessage) {
                const lastContent = lastUserMessage.content.toLowerCase();
                // אם ההודעה החדשה שונה מאוד מהקודמת - התחל מחדש
                const similarity = calculateSimilarity(lowerMessage, lastContent);
                if (similarity < 0.3) { // פחות מ-30% דמיון
                    console.log('🔄 זוהתה בקשה חדשה שונה מההקשר הקודם');
                    return true;
                }
            }
        }
        
        // בדיקה נוספת: אם יש שם או נושא חדש לגמרי
        if (hasNewEntity(message, conversationHistory)) {
            console.log('🔄 זוהה נושא או שם חדש');
            return true;
        }
    }
    
    return false;
}

// פונקציה לחישוב דמיון בין שתי הודעות
function calculateSimilarity(str1, str2) {
    const words1 = str1.split(' ').filter(w => w.length > 2);
    const words2 = str2.split(' ').filter(w => w.length > 2);
    
    if (words1.length === 0 || words2.length === 0) return 0;
    
    const commonWords = words1.filter(word => words2.includes(word));
    return commonWords.length / Math.max(words1.length, words2.length);
}

// פונקציה לזיהוי ישויות חדשות (שמות, פרויקטים וכו')
function hasNewEntity(message, history) {
    // חילוץ שמות פרטיים (מילים שמתחילות באות גדולה)
    const names = message.match(/[A-Z\u0590-\u05FF][a-z\u0590-\u05FF]+/g) || [];
    
    if (names.length > 0) {
        // בדוק אם השמות האלה הופיעו בהיסטוריה
        const historyText = history.map(msg => msg.content).join(' ');
        const newNames = names.filter(name => !historyText.includes(name));
        
        // אם יש שמות חדשים שלא הופיעו קודם
        return newNames.length > 0;
    }
    
    return false;
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

// System Prompt משופר עם תוספות חשובות
const systemPrompt = 'אתה עוזר חכם שמחובר לאיירטיבל.\n\n' +
    '🚨 חוקים קריטיים:\n' +
    '1. כאשר מוצאים רשומה - מיד בצע את הפעולה הנדרשת!\n' +
    '2. אל תחזור ותחפש את אותה רשומה פעמיים!\n' +
    '3. אל תאמר "עכשיו אעדכן" - פשוט עדכן!\n' +
    '4. כל עדכון חייב להיעשות עם הכלי update_record!\n' +
    '5. השתמש במזהה הרשומה (ID) שקיבלת מהחיפוש!\n' +
    '6. אחרי כל פעולה - הודע בבירור מה קרה!\n' +
    '7. אם אתה מקבל שגיאה - נסה גישה אחרת או הסבר למשתמש מה השגיאה!\n\n' +
    
    // תוספת חדשה: כללי עבודה עם שדות
    '🔍 כללי עבודה עם שדות:\n' +
    '- תמיד בדוק את שמות השדות הזמינים לפני יצירה/עדכון\n' +
    '- שדות קשורים (Linked Records) צריכים להיות במבנה: ["recordId"]\n' +
    '- אם שדה לא קיים - השתמש בשם הקרוב ביותר או דווח על השגיאה\n' +
    '- שדות תאריך צריכים להיות בפורמט ISO: "YYYY-MM-DD"\n' +
    '- שדות מספר צריכים להיות ללא מרכאות\n' +
    '- שדות בחירה יחידה/מרובה - השתמש רבדר בערכים המדויקים מהרשימה!\n' +
    '- ⚠️ אסור ליצור ערכים חדשים בשדות בחירה - רק להשתמש בקיימים!\n' +
    '- אם צריך ערך שלא קיים - הודע למשתמש שהערך לא זמין\n\n' +
    
    // תוספת חדשה: טיפול בשגיאות
    '⚠️ טיפול בשגיאות:\n' +
    '- שגיאת "Unknown field name" = השדה לא קיים, בדוק שמות שדות\n' +
    '- שגיאת "INVALID_REQUEST_BODY" = נתונים לא תקינים, בדוק פורמט\n' +
    '- שגיאת "NOT_FOUND" = הרשומה לא קיימת, בדוק ID\n' +
    '- שגיאת "ROW_DOES_NOT_EXIST" = מזהה הרשומה לא קיים! בדוק שהחיפוש הקודם הצליח\n' +
    '- שגיאת "INVALID_MULTIPLE_CHOICE_OPTIONS" = ערך לא תקין בשדה בחירה - השתמש רק בערכים מהרשימה!\n' +
    '- שגיאת "Insufficient permissions to create new select option" = ניסית ליצור ערך חדש בשדה בחירה - אסור!\n' +
    '- אם יש שגיאה - נסה שוב עם נתונים מתוקנים\n' +
    '- לעולם אל תמציא ערכים חדשים לשדות בחירה!\n' +
    '- ⚠️ לפני יצירת עסקה - וודא שהלקוח והפרויקט באמת נמצאו!\n\n' +
    
    // תוספת חדשה: תהליך סטנדרטי
    '📋 תהליך סטנדרטי לפעולות:\n' +
    '1. זיהוי הבקשה - מה המשתמש רוצה?\n' +
    '2. איתור הרשומות הרלוונטיות (search_airtable)\n' +
    '3. ⚠️ וידוא שהחיפוש הצליח ויש תוצאות תקפות!\n' +
    '4. בדיקת שדות זמינים אם נדרש (get_table_fields)\n' +
    '5. ביצוע הפעולה (create_record/update_record) רק עם IDs תקפים\n' +
    '6. דיווח על התוצאה למשתמש\n\n' +
    
    '🎯 תרחיש מיוחד - לקוח השלים הרשמה / העביר דמי רצינות:\n' +
    'כשאומרים לך "לקוח השלים הרשמה" או "העביר דמי רצינות":\n' +
    '1. מצא את הלקוח בטבלת הלקוחות (search_airtable)\n' +
    '2. ⚠️ וודא שנמצא לקוח עם ID תקף!\n' +
    '3. מצא את הפרויקט בטבלת הפרויקטים (search_airtable)\n' +
    '4. ⚠️ וודא שנמצא פרויקט עם ID תקף!\n' +
    '5. בדוק אם יש עסקה קיימת (search_transactions)\n' +
    '6. אם יש עסקה קיימת - הודע: "✅ כבר קיימת עסקה עבור [שם לקוח] ו[שם פרויקט]"\n' +
    '7. אם אין עסקה וכל ה-IDs תקפים - צור עסקה חדשה (create_record)\n' +
    '8. אם הלקוח לא בסטטוס "לקוח בתהליך" - עדכן (update_record)\n' +
    '⚠️ חשוב: אחרי כל בדיקת עסקה - הודע מה המצב!\n' +
    '⚠️ אם נמצאה עסקה קיימת - אמר זאת בבירור!\n' +
    '⚠️ אם לא נמצא לקוח או פרויקט - הודע על כך ואל תנסה ליצור עסקה!\n\n' +
    
    // תוספת חדשה: תרחישים נוספים
    '🎯 תרחישים נוספים:\n' +
    '📞 יצירת ליד חדש:\n' +
    '- צור רשומה בטבלת הלידים (tbl3ZCmqfit2L0iQ0)\n' +
    '- וודא שהפרויקט קיים לפני הקישור\n' +
    '- הגדר סטטוס ליד התחלתי\n\n' +
    '🏢 עדכון סטטוס משרד:\n' +
    '- מצא את המשרד בטבלת המשרדים (tbl7etO9Yn3VH9QpT)\n' +
    '- עדכן את הסטטוס (פנוי/מכור)\n' +
    '- הודע על השינוי\n\n' +
    '💰 עדכון סטטוס עסקה:\n' +
    '- מצא את העסקה בטבלת העסקאות (tblSgYN8CbQcxeT0j)\n' +
    '- עדכן את הסטטוס (בתהליך/נחתמה/בוטלה/שימור)\n' +
    '- עדכן תאריכים רלוונטיים\n\n' +
    
    'Base ID: appL1FfUaRbmPNI01\n\n' +
    '📋 טבלאות ושדות זמינים:\n\n' +
    '🏢 עסקאות (Transactions) - tblSgYN8CbQcxeT0j:\n' +
    '- מזהה עסקה (ID_Deal)\n' +
    '- שם העסקה\n' +
    '- סטטוס עסקה (ערכים: בתהליך, בוטלה, נחתמה, שימור)\n' +
    '- מזהה פרויקט (ID_Project)\n' +
    '- שם הפרויקט (from מזהה פרויקט (ID_Project))\n' +
    '- מזהה לקוח ראשי (ID_Client)\n' +
    '- שם מלא (from מזהה לקוח ראשי (ID_Client))\n' +
    '- מזהה לקוח משני (ID_Client)\n' +
    '- שם מלא (from מזהה לקוח משני (ID_Client))\n' +
    '- סטטוס לקוח בעסקה (ערכים: לא מתקדם, השלים הרשמה, רכש)\n' +
    '- גודל המשרד\n' +
    '- קומה\n' +
    '- הון עצמי\n' +
    '- הלוואת קבלן\n' +
    '- מחיר למ״ר\n' +
    '- חנייה\n' +
    '- מחיר חניה\n' +
    '- גודל מחסן\n' +
    '- מחיר מחסן\n' +
    '- סכום העסקה הכולל\n' +
    '- גובה דמי רצינות\n' +
    '- דמי רצינות שולמו\n' +
    '- שיטת תשלום דמי רצינות (ערכים: צ׳ק, העברה בנקאית)\n' +
    '- תאריך השלמת הרשמה\n' +
    '- עורך דין - לקוח\n' +
    '- טלפון - עו״ד לקוח\n' +
    '- מייל - עו״ד לקוח\n' +
    '- סטטוס משפטי (ערכים: לקוח מחכה להסכם, לקוח קיבל הסכם - מחכים להערות עו״ד, וכו\')\n' +
    '- סטטוס בנק (ערכים: בנק קיבל פרטי לקוח, ממתינים למסמכים, וכו\')\n' +
    '- תאריך חתימת עסקה\n' +
    '- משרד מקושר\n' +
    '- הערות כלליות\n' +
    '- הערות AI\n\n' +
    '👥 לקוחות (Customers) - tblcTFGg6WyKkO5kq:\n' +
    '- מזהה לקוח (ID_Client)\n' +
    '- שם מלא\n' +
    '- טלפון\n' +
    '- אימייל\n' +
    '- סטטוס (ערכים זמינים בלבד: קבע פגישה, התחיל הרשמה, לקוח בתהליך, לקוח רכש, לא התקדם) ⚠️ רק ערכים אלה!\n' +
    '- מועד פגישה ראשונה\n' +
    '- כתובת לקוח\n' +
    '- גודל משרד רצוי\n' +
    '- הערות כלליות\n' +
    '- פרויקט מקור\n' +
    '- תאריך יצירה\n' +
    '- תאריך עדכון אחרון\n\n' +
    '🏗️ פרויקטים (Projects) - tbl9p6XdUrecy2h7G:\n' +
    '- מזהה פרויקט (ID_Project)\n' +
    '- שם הפרויקט\n' +
    '- סוג פרויקט (ערכים: מסחרי, מגורים)\n' +
    '- תאריך תחילת פרויקט\n' +
    '- סטטוס (ערכים: פעיל)\n' +
    '- מנהל מכירות פרונטלי\n' +
    '- שם היזם\n' +
    '- שם איש קשר\n' +
    '- טלפון איש קשר\n' +
    '- מייל איש קשר\n' +
    '- מנהל מכירות טלפוני\n' +
    '- בנק מטפל\n' +
    '- הערות כלליות\n' +
    '- תאריך יצירה\n' +
    '- תאריך עדכון אחרון\n\n' +
    '📞 לידים (Leads) - tbl3ZCmqfit2L0iQ0:\n' +
    '- מזהה ליד (ID_Lead)\n' +
    '- שם מלא\n' +
    '- טלפון\n' +
    '- אימייל\n' +
    '- תאריך יצירת ליד\n' +
    '- סטטוס ליד\n' +
    '- יזם\n' +
    '- מזהה פרויקט\n' +
    '- שם הפרויקט\n' +
    '- הערות כלליות\n' +
    '- גודל משרד רצוי\n\n' +
    '🏢 משרדים (Offices) - tbl7etO9Yn3VH9QpT:\n' +
    '- מזהה משרד (Office_ID)\n' +
    '- שם הפרויקט\n' +
    '- שם המשרד\n' +
    '- סטטוס משרד (ערכים: פנוי, מכור)\n' +
    '- כיוון\n' +
    '- גודל המשרד\n' +
    '- שם איש קשר\n' +
    '- טלפון איש קשר\n' +
    '- מייל איש קשר\n' +
    '- הערות\n' +
    '- תאריך יצירה\n' +
    '- תאריך עדכון אחרון\n\n' +
    '🌸 פרחים (Flowers) - tblNJzcMRtyMdH14d:\n' +
    '- מזהה פרחים (ID_Flowers)\n' +
    '- מזהה פרויקט (ID_Project)\n' +
    '- מזהה לקוח (ID_Client)\n' +
    '- תאריך פרחים\n' +
    '- נשלחו פרחים\n' +
    '- סטטוס פרחים\n' +
    '- כתובת למשלוח\n' +
    '- הערות\n' +
    '- תאריך יצירה\n' +
    '- תאריך עדכון אחרון\n\n' +
    '⚠️ בקרה (Control) - tblYxAM0xNp0z9EoN:\n' +
    '- מזהה בקרה (ID_Control)\n' +
    '- סטטוס\n' +
    '- תאריך יצירה\n' +
    '- הערת איש מכירות\n' +
    '- שגיאה סוכן\n' +
    '- הערת סוכן\n\n' +
    '👨‍💼 מנהלים/עובדים - tbl8JT0j7C35yMcc2:\n' +
    '- מזהה עובד\n' +
    '- שם מלא\n' +
    '- מספר טלפון\n' +
    '- כתובת אימייל\n' +
    '- סוג (ערכים: מנהל פרונטלי, מנהל טלפוני)\n\n' +
    '🛠️ כלים זמינים:\n' +
    '- search_airtable: חיפוש רשומות\n' +
    '- search_transactions: חיפוש עסקות לפי לקוח ופרויקט\n' +
    '- get_all_records: קבלת כל הרשומות\n' +
    '- create_record: יצירת רשומה חדשה\n' +
    '- update_record: עדכון רשומה קיימת (השתמש בזה!)\n' +
    '- get_table_fields: קבלת שדות\n\n' +
    
    // תוספת חדשה: דוגמאות מפורטות
    '💡 דוגמאות לפורמטים נכונים:\n' +
    '- שדה מקושר: {"מזהה פרויקט (ID_Project)": ["recLF0iMhQEx6lMqX"]}\n' +
    '- תאריך: {"תאריך יצירה": "2024-01-15"}\n' +
    '- מספר: {"גודל המשרד": 45}\n' +
    '- טקסט: {"שם מלא": "דונלד טראמפ"}\n' +
    '- בחירה: {"סטטוס": "בתהליך"}\n' +
    '- בוליאני: {"דמי רצינות שולמו": true}\n\n' +
    
    'דוגמאות לשדות קשורים:\n' +
    '- מזהה פרויקט (ID_Project): ["recLF0iMhQEx6lMqX"] (מגדל תל אביב)\n' +
    '- מזהה לקוח (ID_Client): ["rec0GDfLEzXXCUX9X"] (שי טוקטלי)\n' +
    '- סטטוס עסקה: "בתהליך" (לא "התקדם" או כל דבר אחר)\n' +
    '- סטטוס לקוח בעסקה: "לא מתקדם" (לא "לא התקדם")\n\n' +
    '⚡ דוגמה נכונה:\n' +
    'בקשה: "דונלד טראמפ העביר דמי רצינות לפארק רעננה"\n' +
    '1. search_airtable עבור דונלד -> מקבל customer ID\n' +
    '2. search_airtable עבור פארק רעננה -> מקבל project ID\n' +
    '3. search_transactions עבור customer ID + project ID\n' +
    '4. אם יש עסקה -> "✅ כבר קיימת עסקה עבור דונלד טראמפ ופארק רעננה"\n' +
    '5. אם אין עסקה -> create_record בטבלת עסקאות\n\n' +
    
    // תוספת חדשה: כללי תקשורת
    '🗒️ טיפול בהערות:\n' +
    '- אם זו הערה יזומה של הסוכן (תובנה, המלצה, תזכורת) – רשום אותה בעמודת "הערות AI"\n' +
    '- אם זו הערה שביקש המשתמש במפורש (גם אם הצעת קודם) – בעמודת "הערות כלליות"\n' +
    '- אם אין שדה "הערות AI" בטבלה – השתמש ב"הערות כלליות"\n' +
    '- בצע את הוספת ההערות בלי לבקש אישור מהמשתמש\n' +
    '- דוגמאות להערות AI: "לקוח נראה מתלבט", "כדאי לבדוק מצב כספי", "פרויקט מתאים לצרכים"\n' +
    '- דוגמאות להערות כלליות: "לקוח ביקש לעדכן מספר טלפון", "שונה מועד הפגישה"\n' +
    '- תמיד הוסף תאריך להערה אם אפשר: "[תאריך] - [הערה]"\n\n' +
    '💬 כללי תקשורת:\n' +
    '- תמיד הודע למשתמש מה אתה עושה\n' +
    '- אם יש שגיאה - הסבר מה השגיאה ומה אפשר לעשות\n' +
    '- אחרי כל פעולה - סכם מה קרה\n' +
    '- אם משהו לא ברור - שאל שאלות מבהירות\n' +
    '- השתמש באימוג\'ים לבהירות (✅ ❌ 🔍 📝)\n' +
    '- כשמוסיף הערות - הודע איזה סוג הערה נוספה ולאיזה שדה\n\n' +
    '🇮🇱 ענה רק בעברית';
app.post('/claude-query', async(req, res) => {
    try {
        const messageData = req.body;
        const message = messageData.message;
        const sender = messageData.sender || 'default';

        console.log('📨 הודעה מ-' + sender + ':', message);
        
        // בדיקה אם צריך להתחיל שיחה חדשה
        const conversationHistory = getConversationHistory(sender);
        
        if (shouldStartNewConversation(message, conversationHistory)) {
            console.log('🆕 מתחיל שיחה חדשה');
            const data = getConversationData(sender);
            data.history = [];
            data.contextId = Math.random().toString(36).substring(7);
            pendingActions.delete(sender); // נקה גם אישורים מחכים
        }

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

        // קח מחדש את ההיסטוריה אחרי הבדיקות
        const updatedHistory = getConversationHistory(sender);
        addToConversationHistory(sender, 'user', message);

        const messages = updatedHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        // אם זו תחילת שיחה חדשה, הוסף הודעת מערכת לקונטקסט
        if (messages.length === 1) {
            console.log('📝 הוספת הודעת מערכת לשיחה חדשה');
            messages.unshift({
                role: 'user',
                content: 'זו תחילת שיחה חדשה. אל תמשיך פעולות משיחות קודמות. המתן להוראות חדשות מהמשתמש.'
            });
        }

        console.log('🧠 שולח ל-Claude עם', messages.length, 'הודעות');
        console.log('🆔 Context ID:', getConversationData(sender).contextId);

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
    conversationData.delete(sender); // מחק את כל הנתונים
    pendingActions.delete(sender); // נקה גם אישורים מחכים
    console.log('🧹 זיכרון נוקה עבור:', sender);
    res.json({
        success: true,
        message: 'Memory cleared for ' + sender
    });
});

app.get('/memory/:sender?', (req, res) => {
    const sender = req.params.sender || 'default';
    const data = getConversationData(sender);
    const hasPending = pendingActions.has(sender);
    res.json({
        sender: sender,
        contextId: data.contextId,
        historyLength: data.history.length,
        lastActivity: new Date(data.lastActivity).toISOString(),
        timeSinceLastActivity: Date.now() - data.lastActivity,
        history: data.history,
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

// ניקוי אוטומטי של שיחות ישנות (אופציונלי)
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    
    conversationData.forEach((data, senderId) => {
        if (now - data.lastActivity > MEMORY_CONFIG.CONTEXT_TIMEOUT_MS * 2) {
            conversationData.delete(senderId);
            pendingActions.delete(senderId);
            cleaned++;
        }
    });
    
    if (cleaned > 0) {
        console.log('🧹 ניקוי אוטומטי: נמחקו', cleaned, 'שיחות ישנות');
    }
}, 1000 * 60 * 60); // כל שעה

app.listen(3000, '0.0.0.0', () => {
    console.log('🚀 Server running on 0.0.0.0:3000');
    console.log('📝 Functions: search, get records, create, update, get fields');
    console.log('🧪 Test: GET /test-airtable');
    console.log('🧠 Memory: POST /clear-memory, GET /memory');
    console.log('🔔 Confirmation system: create/update actions require approval');
    console.log('⚡ VERSION 2024: Fixed errors + Enhanced prompt for deal deposits');
    console.log('🆕 Smart conversation management - auto-detects new topics');
});
