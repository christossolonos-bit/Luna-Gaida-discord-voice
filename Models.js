// your gemini api key
let geminiKey="AIzaSyCx2lCpCr_lDw8Io3JR0h22RGStTLmTT7o";


let OriginalModels={};
let nameOnlyList = [];
let realModelNames = [];
let GeminiModelsSplitByComma=""
// gemini api
fetch(`https://generativelanguage.googleapis.com/v1alpha/models?key=${geminiKey}`)
    .then(response => {
        return response.json();
    })
    .then(data => {
        OriginalModels = data;
        console.log(data)
        // get the name only list
        
        OriginalModels.models.forEach(model => {
            nameOnlyList.push(model.name);
        });

        // get the real model name
        
        nameOnlyList.forEach(model => {
            let name = model.split('/')[1];
            realModelNames.push(name);
        });

        GeminiModelsSplitByComma = realModelNames.join(',');

        // print
        console.log(GeminiModelsSplitByComma);
        console.log(nameOnlyList);
        console.log(realModelNames);
    })
    .catch(error => console.error(error));