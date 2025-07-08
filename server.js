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

// 🔥 זיכרון מינימלי - רק לאישורים!
const pendingActions = new Map();

// 🚫 ביטלתי את זיכרון השיחה לחלוטין כדי למנוע לולאות!

// פונקציה לזיהוי אישור באמצעות Claude
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
        
        if (['approve', 'reject', 'unclear'].includes(confirmationType)) {
            return confirmationType;
        }
        
        return 'unclear';
        
    } catch (error) {
        console.error('❌ שגיאה בזיהוי אישור:', error);
        return 'unclear';
    }
}

// פונקציה ליצירת הודעת אישור פשוטה ובטוחה
async function createSimpleConfirmationMessage(toolUses) {
    let actionDescription = '';
    
    for (const tool of toolUses) {
        if (tool.name === 'create_record') {
            const tableId = tool.input.tableId;
            const fields = tool.input.fields;
            
            let tableName = 'רשומה';
            if (tableId === 'tblSgYN8CbQcxeT0j') tableName = 'עסקה';
            else if (tableId === 'tblcTFGg6WyKkO5kq') tableName = 'לקוח';
            else if (tableId === 'tbl9p6XdUrecy2h7G') tableName = 'פרויקט';
            
            actionDescription += `🆕 יצירת ${tableName} חדשה`;
            
            if (fields['שם מלא']) actionDescription += ` עבור ${fields['שם מלא']}`;
            if (fields['שם העסקה']) actionDescription += ` - ${fields['שם העסקה']}`;
            if (fields['שם הפרויקט']) actionDescription += ` - ${fields['שם הפרויקט']}`;
            
        } else if (tool.name === 'update_record') {
            const fields = tool.input.fields;
            
            actionDescription += `🔄 עדכון רשומה`;
            
            // הצג רק את השדות שמתעדכנים
            const fieldNames = Object.keys(fields);
            if (fieldNames.length > 0) {
                actionDescription += ` - ${fieldNames.join(', ')}`;
            }
            
        } else if (tool.name === 'delete_records') {
            actionDescription += `🗑️ מחיקת רשומה`;
        }
    }
    
    actionDescription += '\n\n❓ האם לבצע את הפעולה? (כן/לא)';
    return actionDescription;
}

// פונקציה לביצוע פעולה מאושרת
async function executePendingAction(pendingAction) {
    try {
        const { toolUses } = pendingAction;
        
        console.log('🔄 מבצע פעולה מאושרת:', toolUses.length, 'כלים');
        
        const toolsExecuted = [];
        let successCount = 0;
        let errorCount = 0;
        
        for (const toolUse of toolUses) {
            try {
                toolsExecuted.push(toolUse.name);
                console.log('🛠️ מפעיל כלי מאושר:', toolUse.name);

                await handleToolUse(toolUse);
                successCount++;
                console.log('✅ כלי מאושר הושלם:', toolUse.name);

            } catch (toolError) {
                errorCount++;
                console.error('❌ שגיאה בכלי מאושר:', toolUse.name, toolError.message);
            }
        }
        
        let responseText = '';
        if (successCount > 0 && errorCount === 0) {
            responseText = '✅ הפעולה בוצעה בהצלחה!';
        } else if (successCount > 0 && errorCount > 0) {
            responseText = `⚠️ הפעולה בוצעה חלקית: ${successCount} הצליחו, ${errorCount} נכשלו`;
        } else {
            responseText = '❌ הפעולה נכשלה';
        }
        
        return {
            success: true,
            response: responseText,
            toolsExecuted: toolsExecuted
        };
        
    } catch (error) {
        console.error('❌ שגיאה בביצוע פעולה מאושרת:', error);
        return {
            success: false,
            response: '❌ אירעה שגיאה בביצוע הפעולה: ' + error.message
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

// SystemPrompt פשוט וחד
const systemPrompt = 'אתה עוזר חכם שמחובר לאיירטיבל.\n\n' +
    '🚨 חוקים קריטיים:\n' +
    '1. כל שיחה היא נפרדת - אין זיכרון!\n' +
    '2. מצא רשומה -> בצע פעולה -> סיים!\n' +
    '3. מקסימום 3 שלבים בשיחה!\n' +
    '4. אל תחזור על אותה פעולה!\n' +
    '5. אחרי עדכון/יצירה - סיים מיד!\n\n' +
    '🎯 תרחיש הרשמה:\n' +
    '1. חפש לקוח\n' +
    '2. חפש פרויקט  \n' +
    '3. בדוק עסקה קיימת\n' +
    '4. צור/עדכן לפי הצורך\n' +
    '5. סיים!\n\n' +
    'Base ID: appL1FfUaRbmPNI01\n\n' +
    '📋 טבלאות:\n' +
    '- עסקאות: tblSgYN8CbQcxeT0j\n' +
    '- לקוחות: tblcTFGg6WyKkO5kq\n' +
    '- פרויקטים: tbl9p6XdUrecy2h7G\n\n' +
    '🇮🇱 ענה בעברית בקצרה';

app.post('/claude-query', async(req, res) => {
    try {
        const messageData = req.body;
        const message = messageData.message;
        const sender = messageData.sender || 'default';

        console.log('📨 הודעה חדשה מ-' + sender + ':', message);

        // 🔥 בדיקה אם זה אישור לפעולה מחכה
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
                    response: '❌ הפעולה בוטלה',
                    actionCancelled: true
                });
            } else {
                // אם לא ברור - נקה הכל ועבד כבקשה חדשה
                pendingActions.delete(sender);
            }
        }

        // 🔥 כל הודעה היא שיחה חדשה - ללא זיכרון!
        const messages = [{
            role: 'user',
            content: message
        }];

        console.log('🧠 שולח ל-Claude - שיחה חדשה');

        let finalResponse = '';
        let stepCount = 0;
        const maxSteps = 3; // 🚫 מקסימום 3 שלבים!

        // לולאה מוגבלת חזק
        while (stepCount < maxSteps) {
            stepCount++;
            console.log('🔄 שלב', stepCount, 'מתוך', maxSteps);

            // שליחה ל-Claude
            const response = await anthropic.messages.create({
                model: "claude-3-5-sonnet-20241022",
                max_tokens: 2000,
                system: systemPrompt,
                messages: messages,
                tools: airtableTools
            });

            console.log('📝 תגובת Claude (שלב ' + stepCount + ')');

            // בדיקה אם יש כלים להפעיל
            const toolUses = response.content.filter(content => content.type === 'tool_use');

            if (toolUses.length === 0) {
                // אין כלים - זה התשובה הסופית
                const textContent = response.content.find(content => content.type === 'text');
                if (textContent) {
                    finalResponse = textContent.text;
                }
                console.log('✅ שיחה הסתיימה - אין כלים נוספים');
                break;
            }

            // הוסף את תגובת Claude להודעות
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
                // יצירת הודעת אישור פשוטה
                const actionDescription = await createSimpleConfirmationMessage(toolUses);
                
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

            // הפעל כלים רגילים (לא דורשים אישור)
            const toolResults = [];
            for (const toolUse of toolUses) {
                try {
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
                    
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: 'שגיאה: ' + toolError.message
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
        }

        // אם הגענו למגבלת שלבים ללא תגובה סופית
        if (!finalResponse || finalResponse.trim() === '') {
            finalResponse = '✅ הפעולה הושלמה';
        }

        console.log('📤 תגובה סופית:', finalResponse);
        console.log('📊 סה"כ שלבים:', stepCount);

        res.json({
            success: true,
            response: finalResponse,
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

// פונקציה לניקוי זיכרון אישורים
app.post('/clear-memory', (req, res) => {
    const requestData = req.body;
    const sender = requestData.sender || 'default';
    pendingActions.delete(sender);
    console.log('🧹 זיכרון אישורים נוקה עבור:', sender);
    res.json({
        success: true,
        message: 'Confirmation memory cleared for ' + sender
    });
});

app.get('/memory/:sender?', (req, res) => {
    const sender = req.params.sender || 'default';
    const hasPending = pendingActions.has(sender);
    res.json({
        sender: sender,
        hasPendingAction: hasPending,
        pendingActionCount: pendingActions.size
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
    console.log('🧠 Memory: Only confirmations, NO conversation memory');
    console.log('🔥 VERSION 2024: ZERO LOOPS - Each message is FRESH');
});
