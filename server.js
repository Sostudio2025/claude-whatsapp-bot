const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

function loadConfig() {
    // בשרת נשתמש במשתני סביבה
    if (process.env.NODE_ENV === 'production') {
        return {
            CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
            AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY
        };
    }
    
    // בפיתוח נשתמש בקובץ (אם קיים)
    const configPath = path.join(__dirname, 'env_config.txt');
    if (!fs.existsSync(configPath)) {
        // אם אין קובץ, נשתמש גם במשתני סביבה
        return {
            CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
            AIRTABLE_API_KEY: process.env.AIRTABLE_API_KEY
        };
    }
    
    // קריאה מקובץ רק אם הוא קיים
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

// מערכת אישורים - זיכרון זמני לבקשות מחכות לאישור
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

// פונקציה חכמה לזיהוי אישור באמצעות Claude
async function detectConfirmation(message) {
    try {
        const prompt = `נתח את ההודעה הבאה וזהה אם זה אישור או דחייה:

"${message}"

החזר רק אחת מהאפשרויות הבאות:
- approve (אם זה אישור - כן, אוקיי, מאשר, בצע, המשך, סבבה וכו')
- reject (אם זה דחייה - לא, ביטול, עצור, אל תעשה, לא רוצה וכו')
- unclear (אם לא ברור)

החזר רק את המילה המתאימה:`;

        const response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 50,
            messages: [{
                role: 'user',
                content: prompt
            }]
        });

        const confirmationType = response.content[0].text.trim().toLowerCase();
        
        // בדיקת תקינות
        if (['approve', 'reject', 'unclear'].includes(confirmationType)) {
            return confirmationType;
        }
        
        return 'unclear';
        
    } catch (error) {
        console.error('❌ שגיאה בזיהוי אישור:', error);
        return 'unclear';
    }
}

// פונקציה משופרת ליצירת הודעת אישור מפורטת ונוחה לקריאה
async function createDetailedConfirmationMessage(toolUses, originalMessage, messages) {
    let actionDescription = '';
    
    for (const tool of toolUses) {
        if (tool.name === 'create_record') {
            const tableId = tool.input.tableId;
            const fields = tool.input.fields;
            
            // זיהוי טבלה
            let tableName = 'רשומה';
            if (tableId === 'tblSgYN8CbQcxeT0j') tableName = 'עסקה';
            else if (tableId === 'tblcTFGg6WyKkO5kq') tableName = 'לקוח';
            else if (tableId === 'tbl9p6XdUrecy2h7G') tableName = 'פרויקט';
            else if (tableId === 'tbl3ZCmqfit2L0iQ0') tableName = 'ליד';
            else if (tableId === 'tbl7etO9Yn3VH9QpT') tableName = 'משרד';
            else if (tableId === 'tblNJzcMRtyMdH14d') tableName = 'פרח';
            
            actionDescription += `אני עומד ליצור ${tableName} חדשה`;
            
            // הוסף פרטים על השדות החשובים
            if (fields['שם מלא']) actionDescription += ` עבור ${fields['שם מלא']}`;
            if (fields['שם העסקה']) actionDescription += ` - עסקה: ${fields['שם העסקה']}`;
            if (fields['שם הפרויקט']) actionDescription += ` - פרויקט: ${fields['שם הפרויקט']}`;
            
        } else if (tool.name === 'update_record') {
            const tableId = tool.input.tableId;
            const fields = tool.input.fields;
            const recordId = tool.input.recordId;
            
            // חפש בהיסטוריית ההודעות את פרטי הרשומה שנמצאה
            let customerName = '';
            let currentValues = {};
            
            // עבור על ההיסטוריה מהסוף להתחלה למצוא את תוצאת החיפוש האחרונה
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                    for (const content of msg.content) {
                        if (content.type === 'tool_result') {
                            try {
                                const result = JSON.parse(content.content);
                                if (result.records && Array.isArray(result.records)) {
                                    // מצא את הרשומה עם אותו ID
                                    const record = result.records.find(r => r.id === recordId);
                                    if (record && record.fields) {
                                        customerName = record.fields['שם מלא'] || record.fields['שם העסקה'] || record.fields['שם הפרויקט'] || '';
                                        currentValues = record.fields;
                                        break;
                                    }
                                }
                            } catch (e) {
                                // התעלם משגיאות parsing
                            }
                        }
                    }
                    if (customerName) break;
                }
            }
            
            // בנה הודעה ידידותית
            const fieldUpdates = [];
            Object.keys(fields).forEach(fieldName => {
                const newValue = fields[fieldName];
                const currentValue = currentValues[fieldName];
                
                if (fieldName.includes('גודל משרד רצוי') || fieldName === 'גודל משרד רצוי') {
                    if (currentValue) {
                        fieldUpdates.push(`גודל המשרד הרצוי מ-${currentValue} ל-${newValue}`);
                    } else {
                        fieldUpdates.push(`גודל המשרד הרצוי ל-${newValue}`);
                    }
                } else if (fieldName.includes('טלפון') || fieldName === 'טלפון') {
                    if (currentValue) {
                        fieldUpdates.push(`הטלפון מ-${currentValue} ל-${newValue}`);
                    } else {
                        fieldUpdates.push(`הטלפון ל-${newValue}`);
                    }
                } else if (fieldName.includes('אימייל') || fieldName === 'אימייל') {
                    if (currentValue) {
                        fieldUpdates.push(`האימייל מ-${currentValue} ל-${newValue}`);
                    } else {
                        fieldUpdates.push(`האימייל ל-${newValue}`);
                    }
                } else if (fieldName.includes('סטטוס') || fieldName === 'סטטוס') {
                    if (currentValue) {
                        fieldUpdates.push(`הסטטוס מ-${currentValue} ל-${newValue}`);
                    } else {
                        fieldUpdates.push(`הסטטוס ל-${newValue}`);
                    }
                } else if (fieldName.includes('כתובת') || fieldName === 'כתובת לקוח') {
                    if (currentValue) {
                        fieldUpdates.push(`הכתובת מ-${currentValue} ל-${newValue}`);
                    } else {
                        fieldUpdates.push(`הכתובת ל-${newValue}`);
                    }
                } else if (fieldName.includes('הערות') || fieldName === 'הערות כלליות') {
                    const shortNewValue = typeof newValue === 'string' && newValue.length > 30 ? newValue.substring(0, 30) + '...' : newValue;
                    fieldUpdates.push(`ההערות ל-${shortNewValue}`);
                } else {
                    // שדה כללי
                    if (currentValue && typeof newValue === 'string' && newValue.length < 50) {
                        fieldUpdates.push(`${fieldName} מ-${currentValue} ל-${newValue}`);
                    } else if (typeof newValue === 'string' && newValue.length < 50) {
                        fieldUpdates.push(`${fieldName} ל-${newValue}`);
                    } else {
                        fieldUpdates.push(`${fieldName}`);
                    }
                }
            });
            
            // בנה את ההודעה הסופית
            if (customerName && fieldUpdates.length > 0) {
                actionDescription += `אני עומד לעדכן ל${customerName} את ${fieldUpdates.join(' ו')}`;
            } else if (fieldUpdates.length > 0) {
                actionDescription += `אני עומד לעדכן את ${fieldUpdates.join(' ו')}`;
            } else {
                actionDescription += `אני עומד לעדכן רשומה`;
                if (customerName) actionDescription += ` של ${customerName}`;
            }
            
        } else if (tool.name === 'delete_records') {
            actionDescription += `אני עומד למחוק רשומה`;
        }
    }
    
    actionDescription += '\n\n❓ האם אתה מאשר? (כן/לא)';
    return actionDescription;
}

// פונקציה לביצוע פעולה מאושרת
async function executePendingAction(pendingAction) {
    try {
        const { toolUses, messages } = pendingAction;
        
        console.log('🔄 מבצע פעולה מאושרת:', toolUses.length, 'כלים');
        
        const toolResults = [];
        const toolsExecuted = [];
        
        for (const toolUse of toolUses) {
            try {
                toolsExecuted.push(toolUse.name);
                console.log('🛠️ מפעיל כלי מאושר:', toolUse.name);

                const toolResult = await handleToolUse(toolUse);
                console.log('✅ כלי מאושר הושלם:', toolUse.name);

                toolResults.push({
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content: JSON.stringify(toolResult, null, 2)
                });

            } catch (toolError) {
                console.error('❌ שגיאה בכלי מאושר:', toolUse.name, toolError.message);
                
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content: 'שגיאה: ' + toolError.message
                });
            }
        }
        
        // הוסף תוצאות לשיחה וקבל תגובה סופית מClaude
        const updatedMessages = [...messages];
        updatedMessages.push({
            role: 'user',
            content: toolResults
        });
        
        const finalResponse = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 3000,
            system: systemPrompt,
            messages: updatedMessages,
            tools: []
        });
        
        const finalText = finalResponse.content.find(c => c.type === 'text');
        const responseText = finalText ? finalText.text : 'הפעולה בוצעה בהצלחה!';
        
        return {
            success: true,
            response: '✅ ' + responseText,
            toolsExecuted: toolsExecuted
        };
        
    } catch (error) {
        console.error('❌ שגיאה בביצוע פעולה מאושרת:', error);
        return {
            success: false,
            response: 'אירעה שגיאה בביצוע הפעולה: ' + error.message
        };
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

        console.log('✅ נמצאו', filteredRecords.length, 'רשומות בטבלה', tableId);

        // החזר מידע מפורט יותר כדי שClaude יוכל לבצע פעולות
        return {
            found: filteredRecords.length,
            tableId: tableId, // חשוב! שמור את ה-tableId כדי שהעדכון יהיה באותה טבלה
            records: filteredRecords.map(record => ({
                id: record.id,
                tableId: tableId, // הוסף גם כאן
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
        console.log('🔄 מעדכן רשומה:', recordId, 'בטבלה:', tableId);
        console.log('📝 שדות חדשים:', JSON.stringify(fields, null, 2));

        // ראשית - בדוק שהרשומה קיימת בטבלה
        const checkUrl = 'https://api.airtable.com/v0/' + baseId + '/' + tableId + '/' + recordId;
        try {
            await axios.get(checkUrl, {
                headers: {
                    'Authorization': 'Bearer ' + config.AIRTABLE_API_KEY
                }
            });
            console.log('✅ רשומה נמצאה בטבלה:', tableId);
        } catch (checkError) {
            if (checkError.response && checkError.response.status === 404) {
                console.error('❌ רשומה לא נמצאה:', recordId, 'בטבלה:', tableId);
                throw new Error(`Record ID ${recordId} does not exist in table ${tableId}. Please search for the record first in the correct table.`);
            }
            throw checkError;
        }

        // אם הרשומה קיימת - בצע עדכון
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

        console.log('✅ רשומה עודכנה בהצלחה בטבלה:', tableId);
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

// SystemPrompt משופר ומפושט
const systemPrompt = 'אתה עוזר חכם שמחובר לאיירטיבל.\n\n' +
    '🚨 חוקים קריטיים:\n' +
    '1. כאשר מוצאים רשומה - מיד בצע את הפעולה הנדרשת!\n' +
    '2. אל תחזור ותחפש את אותה רשומה פעמיים!\n' +
    '3. אל תאמר "עכשיו אעדכן" - פשוט עדכן!\n' +
    '4. כל עדכון חייב להיעשות עם הכלי update_record!\n' +
    '5. השתמש במזהה הרשומה (ID) שקיבלת מהחיפוש!\n' +
    '6. אחרי כל פעולה - הודע בבירור מה קרה!\n' +
    '7. 🔴 חשוב ביותר: תמיד עדכן רשומה באותה טבלה שבה מצאת אותה!\n' +
    '8. 🔴 אם חיפשת בטבלה X - עדכן בטבלה X!\n' +
    '9. 🔴 אל תיכנס ללולאות - אם מצאת רשומה, עדכן אותה מיד!\n\n' +
    '🎯 תרחיש מיוחד - לקוח השלים הרשמה / העביר דמי רצינות:\n' +
    'כשאומרים לך "לקוח השלים הרשמה" או "העביר דמי רצינות":\n' +
    '1. מצא את הלקוח בטבלת הלקוחות (search_airtable)\n' +
    '2. מצא את הפרויקט בטבלת הפרויקטים (search_airtable)\n' +
    '3. בדוק אם יש עסקה קיימת (search_transactions)\n' +
    '4. אם יש עסקה קיימת - הודע: "✅ כבר קיימת עסקה עבור [שם לקוח] ו[שם פרויקט]"\n' +
    '5. אם אין עסקה - צור עסקה חדשה (create_record)\n' +
    '6. אם הלקוח לא בסטטוס "לקוח בתהליך" - עדכן (update_record)\n\n' +
    'Base ID: appL1FfUaRbmPNI01\n\n' +
    '📋 טבלאות ושדות זמינים:\n\n' +
    '👥 לקוחות (Customers) - tblcTFGg6WyKkO5kq:\n' +
    '- מזהה לקוח (ID_Client)\n' +
    '- שם מלא\n' +
    '- טלפון\n' +
    '- אימייל\n' +
    '- סטטוס (ערכים: לקוח בתהליך, לא התקדם, קבע פגישה)\n' +
    '- מועד פגישה ראשונה\n' +
    '- כתובת לקוח\n' +
    '- גודל משרד רצוי\n' +
    '- הערות כלליות\n' +
    '- פרויקט מקור\n' +
    '- תאריך יצירה\n' +
    '- תאריך עדכון אחרון\n\n' +
    '🏢 עסקאות (Transactions) - tblSgYN8CbQcxeT0j:\n' +
    '- מזהה עסקה (ID_Deal)\n' +
    '- שם העסקה\n' +
    '- סטטוס עסקה (ערכים: בתהליך, בוטלה, נחתמה, שימור)\n' +
    '- מזהה פרויקט (ID_Project)\n' +
    '- שם הפרויקט (from מזהה פרויקט (ID_Project))\n' +
    '- מזהה לקוח ראשי (ID_Client)\n' +
    '- שם מלא (from מזהה לקוח ראשי (ID_Client))\n' +
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
    '- הערות כלליות\n' +
    '- הערות AI\n\n' +
    '🏗️ פרויקטים (Projects) - tbl9p6XdUrecy2h7G:\n' +
    '- מזהה פרויקט (ID_Project)\n' +
    '- שם הפרויקט\n' +
    '- סוג פרויקט (ערכים: מסחרי, מגורים)\n' +
    '- תאריך תחילת פרויקט\n' +
    '- סטטוס (ערכים: פעיל)\n' +
    '- מנהל מכירות פרונטלי\n' +
    '- שם היזם\n' +
    '- הערות כלליות\n' +
    '- תאריך יצירה\n' +
    '- תאריך עדכון אחרון\n\n' +
    '🛠️ כלים זמינים:\n' +
    '- search_airtable: חיפוש רשומות\n' +
    '- search_transactions: חיפוש עסקות לפי לקוח ופרויקט\n' +
    '- get_all_records: קבלת כל הרשומות\n' +
    '- create_record: יצירת רשומה חדשה\n' +
    '- update_record: עדכון רשומה קיימת (השתמש בזה!)\n' +
    '- get_table_fields: קבלת שדות\n\n' +
    '⚡ דוגמה נכונה לעדכון:\n' +
    'בקשה: "תשנה לאוראל מזרחי את הטלפון ל 050-1234567"\n' +
    '1. search_airtable ב-tblcTFGg6WyKkO5kq עבור "אוראל מזרחי"\n' +
    '2. קבל record ID מטבלת הלקוחות\n' +
    '3. update_record ב-tblcTFGg6WyKkO5kq עם השדה "טלפון": "050-1234567"\n' +
    '4. סיום - אל תחזור על הפעולה!\n\n' +
    '🇮🇱 ענה רק בעברית';

app.post('/claude-query', async(req, res) => {
    try {
        const messageData = req.body;
        const message = messageData.message;
        const sender = messageData.sender || 'default';
        const chatId = messageData.chatId;

        console.log('📨 הודעה מ-' + sender + ':', message);

        // בדיקה אם זה אישור לפעולה מחכה
        if (pendingActions.has(sender)) {
            const confirmationType = await detectConfirmation(message);
            
            if (confirmationType === 'approve') {
                const pendingAction = pendingActions.get(sender);
                console.log('✅ מבצע פעולה מאושרת עבור:', sender);
                
                // מחק מהזיכרון
                pendingActions.delete(sender);
                
                // בצע את הפעולה המאושרת
                const result = await executePendingAction(pendingAction);
                
                return res.json({
                    success: true,
                    response: result.response,
                    actionCompleted: true
                });
            } else if (confirmationType === 'reject') {
                pendingActions.delete(sender);
                return res.json({
                    success: true,
                    response: 'הפעולה בוטלה לפי בקשתך. 👍',
                    actionCancelled: true
                });
            } else if (confirmationType === 'unclear') {
                return res.json({
                    success: true,
                    response: 'לא הבנתי את התגובה. אנא כתב "כן" לאישור או "לא" לביטול.',
                    needsClarification: true
                });
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

        // לולאה מוגבלת לביצוע הפעולות - מקסימום 5 שלבים
        while (!conversationFinished && stepCount < 5) {
            stepCount++;
            console.log('🔄 שלב', stepCount);

            response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 3000,
                system: systemPrompt,
                messages: messages,
                tools: airtableTools
            });

            console.log('📝 תגובת Claude (שלב ' + stepCount + '):', JSON.stringify(response, null, 2));

            const toolUses = response.content.filter(content => content.type === 'tool_use');
            
            if (toolUses.length === 0) {
                const textContent = response.content.find(content => content.type === 'text');
                if (textContent) {
                    finalResponse = textContent.text;
                }
                conversationFinished = true;
                console.log('✅ שיחה הסתיימה - אין כלים נוספים');
                break;
            }

            console.log('🛠️ כלים להפעיל:', toolUses.length);
            
            messages.push({
                role: 'assistant',
                content: response.content
            });

            // בדיקה אם יש כלים שדורשים אישור
            const needsConfirmation = toolUses.some(tool => 
                tool.name === 'create_record' || 
                tool.name === 'update_record' || 
                tool.name === 'delete_records'
            );

            if (needsConfirmation) {
                // יצירת הודעת אישור מפורטת עם שם הלקוח והערכים הקיימים
                const actionDescription = await createDetailedConfirmationMessage(toolUses, message, messages);
                
                // שמור את הפעולה בזיכרון
                pendingActions.set(sender, {
                    toolUses: toolUses,
                    messages: messages,
                    stepCount: stepCount,
                    originalMessage: message
                });
                
                return res.json({
                    success: true,
                    response: actionDescription,
                    needsConfirmation: true,
                    chatId: chatId
                });
            }

            // הפעל כלים רגילים (לא דורשים אישור)
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
                        errorMessage = 'שגיאה: השדה שצוינו לא קיים בטבלה.';
                    } else if (errorMessage.includes('status code 422')) {
                        errorMessage = 'שגיאה: נתונים לא תקינים או שדה לא קיים.';
                    } else if (errorMessage.includes('does not exist in this table')) {
                        errorMessage = 'שגיאה: הרשומה לא קיימת בטבלה הזו. אנא חפש את הרשומה תחילה בטבלה הנכונה.';
                    }

                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: 'שגיאה: ' + errorMessage
                    });
                }
            }

            if (toolResults.length > 0) {
                messages.push({
                    role: 'user',
                    content: toolResults
                });
            }

            console.log('📊 כלים שהופעלו עד כה:', toolsExecuted);

            // אם ביצענו עדכון או יצירה - סיים
            if (toolsExecuted.includes('update_record') || toolsExecuted.includes('create_record')) {
                conversationFinished = true;
                finalResponse = 'הפעולה בוצעה בהצלחה!';
                console.log('✅ פעולה מרכזית הושלמה - מסיים');
                break;
            }
        }

        // הכן תגובה סופית
        if (stepCount >= 5 && !finalResponse) {
            console.log('⚠️ הגענו למגבלת שלבים - מכין תגובה סופית');
            finalResponse = 'הפעולה בוצעה חלקית. אנא בדוק את התוצאות במערכת.';
        }

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
    console.log('🧹 זיכרון נוקה עבור:', sender);
    res.json({
        success: true,
        message: 'Memory cleared for ' + sender
    });
});

app.get('/memory/:sender?', (req, res) => {
    const sender = req.params.sender || 'default';
    const history = getConversationHistory(sender);
    res.json({
        sender: sender,
        historyLength: history.length,
        history: history
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
    console.log('🔐 Confirmation system for sensitive operations');
    console.log('⚡ VERSION 2024: Simplified - no immediate responses, fixed loops');
});
