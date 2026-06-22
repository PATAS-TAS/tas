<?php
$API_KEY = getenv('TAS_API_KEY') ?: 'your-api-key';
$BASE_URL = getenv('TAS_BASE_URL') ?: 'https://tas.fly.dev';

function classify($text, $lang = 'en') {
    global $API_KEY, $BASE_URL;
    
    $data = json_encode(['text' => $text, 'lang' => $lang]);
    $ch = curl_init("$BASE_URL/v1/classify");
    
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $data);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        "X-API-Key: $API_KEY"
    ]);
    
    $response = curl_exec($ch);
    curl_close($ch);
    
    return json_decode($response, true);
}

$result = classify('Earn $1000/day working from home! Click https://scam.com');
echo "Spam: " . ($result['spam'] ? 'true' : 'false') . "\n";
echo "Score: " . $result['score'] . "\n";
echo "Reasons: " . json_encode($result['reasons']) . "\n";
?>

