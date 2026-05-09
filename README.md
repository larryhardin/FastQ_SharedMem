This is a simple example of how to implement a fastqueue with a shared memory buffer in node.js.

I used a previous project to create a prompt that I then used to instruct CoPilot to create this one. It mostly worked, just had to tweak requires/imports.

Refer to package.json for dependencies.

To run the server:
npm start

You should see the following information in the console output:
> fastq-sharedmem-service@1.0.0 start
> node src/server.js

Server is running at http://localhost:8080/

The server is ready to handle incoming requests. 
Here is an example request:
curl -s -X POST http://localhost:8080/pricing/requests/control \
  -H 'Content-Type: application/json' \
  -d '{
    "jobControl": {
      "Id": "18284046-96e5-40cf-be2c-b9f0549e5a8k",
      "requestedAt": "2026-03-23T12:00:00Z",
      "timeToWait": "10000"
    },
    "payload": {
      "ensxtx_Action__c": "Simulate",
      "ensxtx_JSName__c": "ensxtxSalesDocInvocableActions_compiled",
      "ensxtx_ObjectType__c": "Quote",
      "ensxtx_RecordId__c": "1Q0Nq000003JOMfKAk",
      "ensxtx_CurrentUserId__c": "005Nq00000ZYx4pIAD",
      "ensxtx_SapDocumentType__c": "Quote",
      "ensxtx_InstanceNumber__c": 6
    }
  }'